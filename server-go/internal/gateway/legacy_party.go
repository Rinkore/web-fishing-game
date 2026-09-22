package gateway

import (
	"errors"
	"net/http"
	"strconv"

	"fishing.local/server/internal/modules/assets"
	"fishing.local/server/internal/modules/identity"
	"fishing.local/server/internal/modules/sea"
	"fishing.local/server/internal/modules/social"
	"github.com/jackc/pgx/v5"
)

// Legacy party routes. The original client speaks {action, target} with
// usernames and implicit invites; the durable module speaks account ids.

var legacyPartyOK = map[string]bool{"created": true, "invited": true, "accepted": true, "declined": true, "disbanded": true, "kicked": true, "left": true}

func (a *API) legacyParty(w http.ResponseWriter, r *http.Request) {
	session, ok := a.authorize(w, r, false)
	if !ok {
		return
	}
	view, err := a.legacyPartyView(r, session.AccountID)
	if err != nil {
		failure(w, err)
		return
	}
	write(w, 200, view)
}

func (a *API) legacyPartyView(r *http.Request, owner int64) (map[string]any, error) {
	ctx := r.Context()
	v, err := social.New(a.pool).PartyView(ctx, owner)
	if err != nil {
		return nil, err
	}
	shared, _ := v["memberZones"].([]sea.SharedZone)
	zones, err := a.legacySharedZones(ctx, shared)
	if err != nil {
		return nil, err
	}
	out := map[string]any{"ok": true, "memberZones": zones, "invite": nil}
	party, _ := v["party"].(social.Party)
	if party.ID > 0 {
		members := []map[string]any{}
		var leaderName, leaderKey string
		rows, err := a.pool.Query(ctx, `SELECT m.owner_id,lower(i.username),i.display_name,EXISTS(SELECT 1 FROM fishing.gateway_streams g WHERE g.owner_id=m.owner_id AND g.expires_at>clock_timestamp()) FROM fishing.party_members m JOIN fishing.identities i ON i.account_id=m.owner_id WHERE m.party_id=$1 ORDER BY m.joined_revision,m.owner_id`, party.ID)
		if err != nil {
			return nil, identity.ErrStorage
		}
		for rows.Next() {
			var id int64
			var name, key string
			var online bool
			if rows.Scan(&id, &key, &name, &online) != nil {
				rows.Close()
				return nil, identity.ErrStorage
			}
			if id == party.LeaderID {
				leaderName = name
				leaderKey = key
			}
			members = append(members, map[string]any{"id": key, "name": name, "online": online})
		}
		if rows.Err() != nil {
			rows.Close()
			return nil, identity.ErrStorage
		}
		rows.Close()
		if leaderName == "" {
			leaderName = strconv.FormatInt(party.LeaderID, 10)
		}
		out["party"] = map[string]any{
			"id": party.ID, "leader": leaderKey, "leaderName": leaderName,
			"members": members, "max": 4,
		}
	} else {
		out["party"] = nil
	}
	if invited, _ := v["invitedPartyId"].(string); invited != "" && invited != "0" {
		id, _ := strconv.ParseInt(invited, 10, 64)
		var leaderName string
		_ = a.pool.QueryRow(ctx, `SELECT COALESCE(i.display_name,'') FROM fishing.party_members m JOIN fishing.identities i ON i.account_id=m.owner_id WHERE m.party_id=$1 ORDER BY m.joined_revision,m.owner_id LIMIT 1`, id).Scan(&leaderName)
		out["invite"] = map[string]any{"id": id, "leaderName": leaderName}
	}
	return out, nil
}

func (a *API) legacyPartyChange(w http.ResponseWriter, r *http.Request) {
	session, ok := a.authorize(w, r, false)
	if !ok {
		return
	}
	var raw struct {
		Action string `json:"action"`
		Target any    `json:"target"`
	}
	if !decode(w, r, &raw) {
		return
	}
	target := ""
	switch v := raw.Target.(type) {
	case string:
		target = v
	case float64:
		target = strconv.FormatInt(int64(v), 10)
	}
	cmd := social.PartyCommand{ActorID: session.AccountID, RequestKey: legacyMarketKey("legacy:party:" + raw.Action), Action: raw.Action}
	switch raw.Action {
	case "invite", "kick":
		targetID, err := a.accountIDByName(r, target)
		if err != nil {
			write(w, 404, map[string]any{"error": "player_not_found", "code": "player_not_found"})
			return
		}
		cmd.TargetID = targetID
	case "accept":
		var partyID int64
		if err := a.pool.QueryRow(r.Context(), `SELECT i.party_id FROM fishing.party_invites i JOIN fishing.parties p ON p.id=i.party_id AND p.active WHERE i.target_id=$1`, session.AccountID).Scan(&partyID); errors.Is(err, pgx.ErrNoRows) {
			write(w, 400, map[string]any{"error": "no_pending_invite", "code": "no_pending_invite"})
			return
		} else if err != nil {
			failure(w, identity.ErrStorage)
			return
		}
		cmd.PartyID = partyID
	case "create", "leave", "disband", "decline":
	default:
		failure(w, identity.ErrInvalid)
		return
	}
	ctx := assets.WithSession(r.Context(), session.AccountID, session.Hash, false)
	res, err := social.New(a.pool).Party(ctx, cmd)
	if err != nil {
		a.legacySeaFailure(w, err)
		return
	}
	if !legacyPartyOK[res.Status] {
		write(w, 400, map[string]any{"error": res.Status, "code": res.Status})
		return
	}
	view, err := a.legacyPartyView(r, session.AccountID)
	if err != nil {
		failure(w, err)
		return
	}
	write(w, 200, map[string]any{"ok": true, "party": view["party"]})
}

func (a *API) accountIDByName(r *http.Request, name string) (int64, error) {
	var id int64
	if err := a.pool.QueryRow(r.Context(), `SELECT account_id FROM fishing.identities WHERE username=$1`, name).Scan(&id); err != nil {
		return 0, err
	}
	return id, nil
}

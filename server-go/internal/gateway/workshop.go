package gateway

import (
	"net/http"

	"fishing.local/server/internal/modules/assets"
	"fishing.local/server/internal/modules/identity"
	"fishing.local/server/internal/modules/workshop"
	"fishing.local/server/internal/rules"
)

func (a *API) workshop(w http.ResponseWriter, r *http.Request) {
	session, ok := a.authorize(w, r, false)
	if !ok {
		return
	}
	var in struct {
		RequestKey string           `json:"requestKey"`
		Action     string           `json:"action"`
		MainID     int64            `json:"mainId,string"`
		SubID      int64            `json:"subId,string"`
		MainAffix  string           `json:"mainAffix"`
		SubAffix   string           `json:"subAffix"`
		MaterialID string           `json:"materialId"`
		Materials  []rules.Material `json:"materials"`
		Pearl      bool             `json:"pearl"`
		Relics     int64            `json:"relics"`
		Target     *int             `json:"target"`
	}
	if !decode(w, r, &in) {
		return
	}
	c, err := rules.Default()
	if err != nil {
		failure(w, identity.ErrStorage)
		return
	}
	target := -1
	if in.Target != nil {
		target = *in.Target
	}
	ctx := assets.WithSession(r.Context(), session.AccountID, session.Hash, false)
	res, err := workshop.New(a.pool, c).Apply(ctx, workshop.Command{ActorID: session.AccountID, RequestKey: in.RequestKey, Action: in.Action, MainID: in.MainID, SubID: in.SubID, MainAffix: in.MainAffix, SubAffix: in.SubAffix, MaterialID: in.MaterialID, Materials: in.Materials, Pearl: in.Pearl, Relics: in.Relics, Target: target})
	assetResponse(w, res, err)
}
func (a *API) chest(w http.ResponseWriter, r *http.Request) {
	session, ok := a.authorize(w, r, false)
	if !ok {
		return
	}
	var in struct {
		RequestKey string `json:"requestKey"`
		Action     string `json:"action"`
		ChestID    string `json:"chestId"`
		Part       string `json:"part"`
		BaseID     string `json:"baseId"`
		Quantity   int64  `json:"quantity"`
	}
	if !decode(w, r, &in) {
		return
	}
	c, err := rules.Default()
	if err != nil {
		failure(w, identity.ErrStorage)
		return
	}
	ctx := assets.WithSession(r.Context(), session.AccountID, session.Hash, false)
	res, err := workshop.New(a.pool, c).Chest(ctx, workshop.ChestCommand{ActorID: session.AccountID, RequestKey: in.RequestKey, Action: in.Action, ChestID: in.ChestID, Part: in.Part, BaseID: in.BaseID, Quantity: in.Quantity})
	assetResponse(w, res, err)
}

// gear-preview creates synthetic local data only. It cannot target a remote DB.
package main

import (
	"context"
	"crypto/hmac"
	"crypto/sha1"
	"encoding/base32"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"fishing.local/server/internal/modules/assets"
	"fishing.local/server/internal/modules/identity"
	"fishing.local/server/internal/modules/workshop"
	"fishing.local/server/internal/rules"
	"fishing.local/server/migrations"
	"fmt"
	"github.com/jackc/pgx/v5/pgxpool"
	"os"
	"time"
)

const secret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"

func otp() string {
	key, _ := base32.StdEncoding.WithPadding(base32.NoPadding).DecodeString(secret)
	m := hmac.New(sha1.New, key)
	var b [8]byte
	binary.BigEndian.PutUint64(b[:], uint64(time.Now().Unix()/30))
	m.Write(b[:])
	raw := m.Sum(nil)
	i := raw[len(raw)-1] & 15
	return fmt.Sprintf("%06d", (binary.BigEndian.Uint32(raw[i:i+4])&0x7fffffff)%1000000)
}
func main() {
	if len(os.Args) > 1 && os.Args[1] == "otp" {
		fmt.Println(otp())
		return
	}
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
func run() error {
	ctx := context.Background()
	cfg, err := pgxpool.ParseConfig(os.Getenv("FISHING_GO_TEST_DATABASE_URL"))
	if err != nil {
		return err
	}
	if cfg.ConnConfig.Database != "fishing_test" || (cfg.ConnConfig.Host != "127.0.0.1" && cfg.ConnConfig.Host != "localhost") {
		return fmt.Errorf("requires loopback fishing_test bootstrap")
	}
	boot, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		return err
	}
	defer boot.Close()
	var exists bool
	if err = boot.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM pg_database WHERE datname='fishing_gear_preview')").Scan(&exists); err != nil {
		return err
	}
	if !exists {
		if _, err = boot.Exec(ctx, "CREATE DATABASE fishing_gear_preview"); err != nil {
			return err
		}
	}
	cfg = cfg.Copy()
	cfg.ConnConfig.Database = "fishing_gear_preview"
	db, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		return err
	}
	defer db.Close()
	if err = migrations.Apply(ctx, db); err != nil {
		return err
	}
	c, err := rules.Default()
	if err != nil {
		return err
	}
	if err = rules.ValidateCatalog(c); err != nil {
		return err
	}
	if err = workshop.SeedDefinitions(ctx, db, c); err != nil {
		return err
	}
	mfaKey := make([]byte, 32)
	svc := identity.New(db, mfaKey)
	for _, name := range []string{"gear_demo", "gear_admin"} {
		var owner int64
		err = db.QueryRow(ctx, "SELECT account_id FROM fishing.identities WHERE username=$1", name).Scan(&owner)
		if err == nil {
			var seeded bool
			db.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM fishing.gear_progress WHERE owner_id=$1)", owner).Scan(&seeded)
			if seeded {
				continue
			}
		} else {
			reg, e := svc.Register(ctx, identity.Registration{Username: name, Password: "LocalGear2026!", Name: map[string]string{"gear_demo": "装备测试员", "gear_admin": "本地管理员"}[name], QQ: "12345678"})
			if e != nil {
				return e
			}
			owner = reg.Session.AccountID
		}
		stacks := []assets.StackDelta{}
		for _, it := range c.Items {
			if it.Kind == "material" || it.Kind == "chest" {
				stacks = append(stacks, assets.StackDelta{ItemID: it.ID, Tier: "normal", Quantity: 1000})
			}
		}
		items := []assets.EquipmentSpec{}
		add := func(sig string) {
			b, _, _, _ := c.Instance(sig)
			raw, _ := json.Marshal(map[string]any{"signature": sig, "bound": false})
			items = append(items, assets.EquipmentSpec{DefinitionID: b.ID, Part: b.Part, Attributes: raw})
		}
		for part, p := range c.GearConfig().Parts {
			for _, lv := range []int{0, 3, 8} {
				sig, _ := c.GearSignature("gear_"+part+"_1", lv, p.Subs[0], "none", 0)
				add(sig)
			}
		}
		add("reel_smooth#epic#spd+8")
		for _, s := range c.GearSets() {
			if s.Pending {
				continue
			}
			for _, p := range s.Pieces {
				for range 5 {
					sig, ok := c.GearCoreSignature(s.ID, p.Part)
					if !ok {
						b, _ := c.Item("set_" + s.ID + "_" + p.Part)
						sig = rules.InstanceID(b, "epic", []rules.Affix{{Type: p.Type, Value: p.Value}})
					}
					add(sig)
				}
			}
		}
		r, e := assets.New(db).ApplyChange(ctx, assets.Change{ActorID: owner, RequestKey: "gear-preview-synthetic-seed", Reason: "reward", RuleVersion: "gear-preview-v1", Coins: 2000000, Stacks: stacks, Create: items})
		if e != nil || r.Status != "applied" {
			return fmt.Errorf("seed assets: %v %v", r, e)
		}
		if _, err = db.Exec(ctx, "INSERT INTO fishing.gear_progress(owner_id,state) VALUES($1,$2)", owner, `{"receipts":100,"heat":30,"tiers":{"forge":3,"harvest":3,"apex":3,"research":0,"tide":3,"wreck":3,"storm":3,"rescue":3},"unlocked":{"tide":true,"wreck":true,"storm":true,"rescue":true},"selected":"tide","voyageMode":"normal"}`); err != nil {
			return err
		}
		if _, err = db.Exec(ctx, "INSERT INTO fishing.sea_players(owner_id,level,experience,charts) VALUES($1,5,10000,10)", owner); err != nil {
			return err
		}
		if _, err = db.Exec(ctx, "INSERT INTO fishing.sea_captains(owner_id,marks,starter) VALUES($1,500,1)", owner); err != nil {
			return err
		}
		if name == "gear_admin" {
			if err = identity.ProvisionAdmin(ctx, db, mfaKey, name, secret, otp()); err != nil {
				return err
			}
		}
	}
	fmt.Println("Synthetic preview ready: gear_demo / gear_admin; password LocalGear2026!; database fishing_gear_preview")
	fmt.Println("Local MFA encryption key:", base64.StdEncoding.EncodeToString(mfaKey))
	return nil
}

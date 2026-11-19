import express from "express";
import type Database from "better-sqlite3";
import { RedemptionService, type Member, type RedeemRequest, type RedeemResult } from "./service.ts";

export function createLoyaltyApp(db: Database.Database, auth: (token: string | undefined) => Member | null, fulfillmentUrl: string, service: { redeem(m: Member, r: RedeemRequest): RedeemResult | Promise<RedeemResult> } = new RedemptionService(db, () => Date.now(), fulfillmentUrl)) {
  const app = express();
  app.use(express.json());
  app.post("/redemptions", async (req, res) => {
    const member = auth(req.header("authorization")?.slice(7));
    if (!member) return res.status(401).end();
    const { rewardId, quantity, note } = req.body ?? {};
    if (typeof rewardId !== "string" || !Number.isInteger(quantity) || quantity < 1) return res.status(400).end();
    const r = await service.redeem(member, { rewardId, quantity, note });
    res.status(r.status === "redeemed" ? 201 : 422).json(r);
  });
  app.get("/rewards", (req, res) => {
    const member = auth(req.header("authorization")?.slice(7));
    if (!member) return res.status(401).end();
    res.json(db.prepare("SELECT id, cost, stock, min_tier FROM rewards WHERE tenant_id = ?").all(member.tenantId));
  });
  return app;
}

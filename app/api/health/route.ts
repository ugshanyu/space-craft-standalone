import { NextResponse } from "next/server";

export async function GET() {
  const region = process.env.RAILWAY_REGION || process.env.AWS_REGION || process.env.FLY_REGION || "unknown";
  const simHz = Number(process.env.SIM_TICK_HZ || 60);
  const netHz = Number(process.env.NETWORK_HZ || 30);
  return NextResponse.json({
    status: "ok",
    service: "space-craft",
    ts: Date.now(),
    region,
    sim_hz: simHz,
    net_hz: netHz,
  });
}

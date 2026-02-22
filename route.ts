import { NextResponse } from "next/server";

/**
 * MGC assumptions (defaults; can be parameterized later)
 * - Tick size: 0.1
 * - Tick value: $1
 * - Dollar per 1.0 point: $10
 */
const DEFAULT_DOLLAR_PER_POINT = 10;

type Candle = { ts: number; o: number; h: number; l: number; c: number; v?: number };

type Params = {
  riskPerCampaign: number; // 200
  maxCampaignsPerDay: number; // 2
  dailyLossLimit: number; // e.g. 400
  maxContracts: number; // e.g. 3

  // Box detection
  boxBars: number; // e.g. 6
  atrLen5: number; // e.g. 20
  atrLen1: number; // e.g. 14
  minBoxAtrMult: number; // 0.6
  maxBoxAtrMult: number; // 1.6

  // Breakout/stop buffers as ATR5 fractions
  breakBufferAtr5: number; // 0.10
  stopBufferAtr5: number; // 0.10

  // Starter location requirement (top/bottom % of box)
  starterBandPct: number; // 0.25 (top/bottom 25%)

  // Profit mgmt
  trailLookback: number; // 8
  // Slippage & commission (later)
  slippagePoints: number; // 0
  commissionPerContract: number; // 0

  dollarPerPoint: number; // default 10
};

type Trade = {
  direction: "LONG" | "SHORT";
  entryTs: number;
  exitTs: number;
  entryPrice: number;
  exitPrice: number;
  qty: number;
  pnl: number;
  rMultiple: number;
  tags: string[];
};

type EquityPoint = { ts: number; equity: number };

function aggregateTo5m(candles1m: Candle[]): Candle[] {
  const out: Candle[] = [];
  let bucketStart = -1;
  let cur: Candle | null = null;

  for (const c of candles1m) {
    const bucket = Math.floor(c.ts / (5 * 60_000)) * (5 * 60_000);
    if (bucket !== bucketStart) {
      if (cur) out.push(cur);
      bucketStart = bucket;
      cur = { ts: bucket, o: c.o, h: c.h, l: c.l, c: c.c, v: c.v ?? 0 };
    } else if (cur) {
      cur.h = Math.max(cur.h, c.h);
      cur.l = Math.min(cur.l, c.l);
      cur.c = c.c;
      cur.v = (cur.v ?? 0) + (c.v ?? 0);
    }
  }
  if (cur) out.push(cur);
  return out;
}

function computeATR(candles: Candle[], len: number): Array<number | null> {
  const atr: Array<number | null> = new Array(candles.length).fill(null);
  let trSum = 0;

  const tr = (i: number) => {
    if (i === 0) return candles[i].h - candles[i].l;
    const prevC = candles[i - 1].c;
    return Math.max(
      candles[i].h - candles[i].l,
      Math.abs(candles[i].h - prevC),
      Math.abs(candles[i].l - prevC)
    );
  };

  for (let i = 0; i < candles.length; i++) {
    const v = tr(i);
    trSum += v;
    if (i >= len) trSum -= tr(i - len);

    if (i >= len - 1) atr[i] = trSum / len;
  }
  return atr;
}

function dayKeyUTC(ts: number): string {
  const d = new Date(ts);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function clamp(n: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, n));
}

function round2(n: number) {
  return Math.round(n * 100) / 100;
}

function calcPnl(
  direction: "LONG" | "SHORT",
  entry: number,
  exit: number,
  qty: number,
  dollarPerPoint: number,
  commissionPerContract: number
) {
  const pts = direction === "LONG" ? exit - entry : entry - exit;
  const gross = pts * dollarPerPoint * qty;
  const comm = commissionPerContract * qty * 2; // round trip
  return gross - comm;
}

type Box = {
  start5mIndex: number;
  end5mIndex: number;
  high: number;
  low: number;
  mid: number;
  atr5: number;
};

function findBoxes(c5: Candle[], atr5: Array<number | null>, p: Params): Box[] {
  const boxes: Box[] = [];
  const N = p.boxBars;

  for (let i = N - 1; i < c5.length; i++) {
    const a = atr5[i];
    if (a == null) continue;

    const start = i - (N - 1);
    let hi = -Infinity;
    let lo = Infinity;

    // Build range
    for (let k = start; k <= i; k++) {
      hi = Math.max(hi, c5[k].h);
      lo = Math.min(lo, c5[k].l);
    }

    const range = hi - lo;
    const minR = p.minBoxAtrMult * a;
    const maxR = p.maxBoxAtrMult * a;
    if (range < minR || range > maxR) continue;

    // All closes within [lo, hi]
    let ok = true;
    for (let k = start; k <= i; k++) {
      if (c5[k].c < lo || c5[k].c > hi) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;

    // Optional: prevent duplicates (only take new box if it differs meaningfully)
    const last = boxes[boxes.length - 1];
    if (last && Math.abs(last.high - hi) < 1e-9 && Math.abs(last.low - lo) < 1e-9) {
      continue;
    }

    boxes.push({
      start5mIndex: start,
      end5mIndex: i,
      high: hi,
      low: lo,
      mid: (hi + lo) / 2,
      atr5: a,
    });
  }

  return boxes;
}

type Position = {
  direction: "LONG" | "SHORT";
  qty: number;
  avgEntry: number;
  stop: number;
  // track partial exits
  initialRiskPts: number;
  hasTaken1R: boolean;
  hasTaken2R: boolean;
  tags: string[];
  entryTs: number;
  // for trade aggregation
  realizedPnl: number;
  realizedQty: number; // qty already realized out
};

function weightedAvgPrice(avg: number, qty: number, addPx: number, addQty: number) {
  return (avg * qty + addPx * addQty) / (qty + addQty);
}

function minLow(c1: Candle[], i: number, lookback: number) {
  let lo = Infinity;
  const start = Math.max(0, i - lookback + 1);
  for (let k = start; k <= i; k++) lo = Math.min(lo, c1[k].l);
  return lo;
}
function maxHigh(c1: Candle[], i: number, lookback: number) {
  let hi = -Infinity;
  const start = Math.max(0, i - lookback + 1);
  for (let k = start; k <= i; k++) hi = Math.max(hi, c1[k].h);
  return hi;
}

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const candles1mRaw: Candle[] = body.candles1m;
    const strategy = body.strategy;
    const userParams = body.params ?? {};

    if (strategy !== "mgc_accum_breakout") {
      return NextResponse.json({ error: "Unknown strategy" }, { status: 400 });
    }
    if (!Array.isArray(candles1mRaw) || candles1mRaw.length < 500) {
      return NextResponse.json({ error: "Need at least ~500 1m candles" }, { status: 400 });
    }

    // Sort & basic sanitize
    const candles1m = [...candles1mRaw]
      .filter((c) => Number.isFinite(c.ts) && Number.isFinite(c.o) && Number.isFinite(c.h) && Number.isFinite(c.l) && Number.isFinite(c.c))
      .sort((a, b) => a.ts - b.ts);

    const candles5m = aggregateTo5m(candles1m);

    const p: Params = {
      riskPerCampaign: Number(userParams.riskPerCampaign ?? 200),
      maxCampaignsPerDay: Number(userParams.maxCampaignsPerDay ?? 2),
      dailyLossLimit: Number(userParams.dailyLossLimit ?? 400),
      maxContracts: Number(userParams.maxContracts ?? 3),

      boxBars: Number(userParams.boxBars ?? 6),
      atrLen5: Number(userParams.atrLen5 ?? 20),
      atrLen1: Number(userParams.atrLen1 ?? 14),
      minBoxAtrMult: Number(userParams.minBoxAtrMult ?? 0.6),
      maxBoxAtrMult: Number(userParams.maxBoxAtrMult ?? 1.6),

      breakBufferAtr5: Number(userParams.breakBufferAtr5 ?? 0.10),
      stopBufferAtr5: Number(userParams.stopBufferAtr5 ?? 0.10),

      starterBandPct: Number(userParams.starterBandPct ?? 0.25),

      trailLookback: Number(userParams.trailLookback ?? 8),

      slippagePoints: Number(userParams.slippagePoints ?? 0),
      commissionPerContract: Number(userParams.commissionPerContract ?? 0),

      dollarPerPoint: Number(userParams.dollarPerPoint ?? DEFAULT_DOLLAR_PER_POINT),
    };

    // Indicators
    const atr1 = computeATR(candles1m, p.atrLen1);
    const atr5 = computeATR(candles5m, p.atrLen5);

    // Boxes from 5m
    const boxes = findBoxes(candles5m, atr5, p);

    // Map each 1m bar to most recent 5m box (if any)
    // We'll attach box when 1m ts is >= box end ts and < next box end ts (simple)
    let boxPtr = 0;
    let activeBox: Box | null = null;

    const trades: Trade[] = [];
    const equity: EquityPoint[] = [];

    let equityVal = 0;
    let pos: Position | null = null;

    let dailyPnl = 0;
    let dailyCampaigns = 0;
    let currentDay = dayKeyUTC(candles1m[0].ts);

    function closePosition(i: number, exitPrice: number, reason: string) {
      if (!pos) return;
      const exitTs = candles1m[i].ts;

      const qtyToClose = pos.qty;
      const pnl = calcPnl(pos.direction, pos.avgEntry, exitPrice, qtyToClose, p.dollarPerPoint, p.commissionPerContract);

      // Estimate R multiple using initialRiskPts (per contract)
      const rMultiple = pos.initialRiskPts > 0 ? (pos.direction === "LONG" ? (exitPrice - pos.avgEntry) / pos.initialRiskPts : (pos.avgEntry - exitPrice) / pos.initialRiskPts) : 0;

      trades.push({
        direction: pos.direction,
        entryTs: pos.entryTs,
        exitTs,
        entryPrice: round2(pos.avgEntry),
        exitPrice: round2(exitPrice),
        qty: qtyToClose,
        pnl: round2(pnl + pos.realizedPnl),
        rMultiple: round2((pos.realizedPnl / (p.dollarPerPoint * (pos.initialRiskPts || 1))) + rMultiple),
        tags: [...pos.tags, reason],
      });

      equityVal += pnl + pos.realizedPnl;
      dailyPnl += pnl + pos.realizedPnl;

      equity.push({ ts: exitTs, equity: round2(equityVal) });

      pos = null;
    }

    function partialExit(i: number, exitPrice: number, qtyExit: number, tag: string) {
      if (!pos) return;
      qtyExit = clamp(qtyExit, 0, pos.qty);
      if (qtyExit <= 0) return;

      const pnl = calcPnl(pos.direction, pos.avgEntry, exitPrice, qtyExit, p.dollarPerPoint, p.commissionPerContract);
      pos.qty -= qtyExit;
      pos.realizedPnl += pnl;
      pos.realizedQty += qtyExit;
      pos.tags.push(tag);

      equityVal += pnl;
      dailyPnl += pnl;
      equity.push({ ts: candles1m[i].ts, equity: round2(equityVal) });
    }

    function canAdd(nextAvg: number, nextQty: number, stop: number): boolean {
      // Campaign risk = qty * |avgEntry - stop| * dollarPerPoint
      const riskPts = Math.abs(nextAvg - stop);
      const risk = nextQty * riskPts * p.dollarPerPoint;
      return risk <= p.riskPerCampaign + 1e-9;
    }

    // Main loop over 1m bars
    for (let i = 2; i < candles1m.length; i++) {
      const c = candles1m[i];

      // Daily reset
      const dkey = dayKeyUTC(c.ts);
      if (dkey !== currentDay) {
        currentDay = dkey;
        dailyPnl = 0;
        dailyCampaigns = 0;
      }

      // Update active box pointer based on 5m boxes end time
      while (boxPtr < boxes.length) {
        const boxEndTs = candles5m[boxes[boxPtr].end5mIndex].ts;
        if (c.ts >= boxEndTs) {
          activeBox = boxes[boxPtr];
          boxPtr++;
          continue;
        }
        break;
      }

      // If we have an open position, manage it
      if (pos) {
        // Stop check intrabar
        if (pos.direction === "LONG") {
          if (c.l <= pos.stop) {
            closePosition(i, pos.stop, "STOP");
            continue;
          }
        } else {
          if (c.h >= pos.stop) {
            closePosition(i, pos.stop, "STOP");
            continue;
          }
        }

        // Profit-taking / trailing
        const riskPts = pos.initialRiskPts;
        if (riskPts > 0) {
          const oneR = pos.direction === "LONG" ? pos.avgEntry + riskPts : pos.avgEntry - riskPts;
          const twoR = pos.direction === "LONG" ? pos.avgEntry + 2 * riskPts : pos.avgEntry - 2 * riskPts;

          if (!pos.hasTaken1R) {
            const hit = pos.direction === "LONG" ? c.h >= oneR : c.l <= oneR;
            if (hit) {
              // take 1 contract off if possible
              partialExit(i, oneR, Math.min(1, pos.qty), "TP_1R");
              pos.hasTaken1R = true;

              // move stop to breakeven
              pos.stop = pos.avgEntry;
            }
          }

          if (pos && !pos.hasTaken2R) {
            const hit = pos.direction === "LONG" ? c.h >= twoR : c.l <= twoR;
            if (hit) {
              partialExit(i, twoR, Math.min(1, pos.qty), "TP_2R");
              pos.hasTaken2R = true;
            }
          }

          // Trail remaining
          if (pos && pos.qty > 0 && pos.hasTaken1R) {
            if (pos.direction === "LONG") {
              const trail = minLow(candles1m, i, p.trailLookback);
              pos.stop = Math.max(pos.stop, trail);
            } else {
              const trail = maxHigh(candles1m, i, p.trailLookback);
              pos.stop = Math.min(pos.stop, trail);
            }
          }

          // If we scaled out completely
          if (pos && pos.qty === 0) {
            // we already realized full pnl into equity; create a final trade record with exit = last partial price
            // For MVP we’ll close it at current close (informational)
            trades.push({
              direction: pos.direction,
              entryTs: pos.entryTs,
              exitTs: c.ts,
              entryPrice: round2(pos.avgEntry),
              exitPrice: round2(c.c),
              qty: pos.realizedQty,
              pnl: round2(pos.realizedPnl),
              rMultiple: round2(pos.realizedPnl / (p.dollarPerPoint * (pos.initialRiskPts || 1))),
              tags: [...pos.tags, "FULL_SCALE_OUT"],
            });
            pos = null;
            continue;
          }
        }

        // Continue loop
        continue;
      }

      // No position: check daily risk lock
      if (dailyPnl <= -Math.abs(p.dailyLossLimit)) continue;
      if (dailyCampaigns >= p.maxCampaignsPerDay) continue;

      // Need an active box and ATR values
      if (!activeBox) continue;

      const a5 = activeBox.atr5;
      if (!Number.isFinite(a5) || a5 <= 0) continue;

      const boxHigh = activeBox.high;
      const boxLow = activeBox.low;
      const boxMid = activeBox.mid;
      const boxRange = boxHigh - boxLow;

      const breakBuffer = p.breakBufferAtr5 * a5;
      const stopBuffer = p.stopBufferAtr5 * a5;

      const topBand = boxHigh - p.starterBandPct * boxRange;
      const botBand = boxLow + p.starterBandPct * boxRange;

      // 1m trigger candles
      const prev = candles1m[i - 1];

      // Starter entry logic (inside box, near top/bottom band, 1m push)
      const longStarter =
        c.c >= topBand &&
        c.c <= boxHigh &&
        c.c > boxMid &&
        c.c > prev.h &&
        c.c >= boxLow &&
        c.c <= boxHigh;

      const shortStarter =
        c.c <= botBand &&
        c.c >= boxLow &&
        c.c < boxMid &&
        c.c < prev.l &&
        c.c >= boxLow &&
        c.c <= boxHigh;

      // Candidate direction
      let dir: "LONG" | "SHORT" | null = null;
      if (longStarter) dir = "LONG";
      else if (shortStarter) dir = "SHORT";
      else continue;

      // Stop based on box boundary
      let stop = dir === "LONG" ? boxLow - stopBuffer : boxHigh + stopBuffer;

      // Entry price = next bar open (simple fill model)
      const next = candles1m[i + 1];
      if (!next) continue;
      const entry = next.o + (dir === "LONG" ? p.slippagePoints : -p.slippagePoints);

      // Initial risk per contract
      const riskPts = Math.abs(entry - stop);
      const riskDollars1 = riskPts * p.dollarPerPoint;

      // If 1 contract already exceeds risk cap, skip
      if (riskDollars1 > p.riskPerCampaign) continue;

      // Open position
      pos = {
        direction: dir,
        qty: 1,
        avgEntry: entry,
        stop,
        initialRiskPts: riskPts,
        hasTaken1R: false,
        hasTaken2R: false,
        tags: ["STARTER"],
        entryTs: next.ts,
        realizedPnl: 0,
        realizedQty: 0,
      };

      dailyCampaigns += 1;

      // After opening starter, we will attempt scale-ins as we progress on subsequent bars.
      // We implement scale-ins by checking breakout/retest while position is open (in the management section).
      // For MVP: implement adds in the same loop by peeking forward as we advance (handled below by additional logic).
    }

    /**
     * Second pass to handle adds (breakout & retest) while position is open:
     * Simpler approach: run again but now with position mgmt + add rules combined.
     *
     * For MVP we do it properly in one pass by re-running loop with add rules.
     * To keep the code readable: We already have mgmt logic above; adds should be checked while pos is open.
     * We'll do a lightweight add scan now by simulating again but with trade list already created would duplicate.
     *
     * => Instead: implement adds inside the main loop by moving add checks into the "if(pos)" block.
     *
     * So: we need to re-run with integrated adds. Since we already ran, we’ll just return this MVP without adds,
     * but the user asked to scale. We'll add it now with a second full simulation using integrated adds.
     */

    // --- Integrated simulation with adds (fresh run) ---
    // Reset and run properly.
    const trades2: Trade[] = [];
    const equity2: EquityPoint[] = [];
    let equityVal2 = 0;
    let pos2: Position | null = null;
    let dailyPnl2 = 0;
    let dailyCampaigns2 = 0;
    let currentDay2 = dayKeyUTC(candles1m[0].ts);

    boxPtr = 0;
    activeBox = null;

    function closePos2(i: number, exitPrice: number, reason: string) {
      if (!pos2) return;
      const exitTs = candles1m[i].ts;

      const qtyToClose = pos2.qty;
      const pnl = calcPnl(pos2.direction, pos2.avgEntry, exitPrice, qtyToClose, p.dollarPerPoint, p.commissionPerContract);

      const rMultiple = pos2.initialRiskPts > 0
        ? (pos2.direction === "LONG"
            ? (exitPrice - pos2.avgEntry) / pos2.initialRiskPts
            : (pos2.avgEntry - exitPrice) / pos2.initialRiskPts)
        : 0;

      trades2.push({
        direction: pos2.direction,
        entryTs: pos2.entryTs,
        exitTs,
        entryPrice: round2(pos2.avgEntry),
        exitPrice: round2(exitPrice),
        qty: qtyToClose + pos2.realizedQty,
        pnl: round2(pnl + pos2.realizedPnl),
        rMultiple: round2((pos2.realizedPnl / (p.dollarPerPoint * (pos2.initialRiskPts || 1))) + rMultiple),
        tags: [...pos2.tags, reason],
      });

      equityVal2 += pnl + pos2.realizedPnl;
      dailyPnl2 += pnl + pos2.realizedPnl;
      equity2.push({ ts: exitTs, equity: round2(equityVal2) });

      pos2 = null;
    }

    function partial2(i: number, exitPrice: number, qtyExit: number, tag: string) {
      if (!pos2) return;
      qtyExit = clamp(qtyExit, 0, pos2.qty);
      if (qtyExit <= 0) return;

      const pnl = calcPnl(pos2.direction, pos2.avgEntry, exitPrice, qtyExit, p.dollarPerPoint, p.commissionPerContract);
      pos2.qty -= qtyExit;
      pos2.realizedPnl += pnl;
      pos2.realizedQty += qtyExit;
      pos2.tags.push(tag);

      equityVal2 += pnl;
      dailyPnl2 += pnl;
      equity2.push({ ts: candles1m[i].ts, equity: round2(equityVal2) });
    }

    function canAdd2(nextAvg: number, nextQty: number, stop: number): boolean {
      const riskPts = Math.abs(nextAvg - stop);
      const risk = nextQty * riskPts * p.dollarPerPoint;
      return risk <= p.riskPerCampaign + 1e-9;
    }

    for (let i = 2; i < candles1m.length - 1; i++) {
      const c = candles1m[i];
      const next = candles1m[i + 1];

      const dkey = dayKeyUTC(c.ts);
      if (dkey !== currentDay2) {
        currentDay2 = dkey;
        dailyPnl2 = 0;
        dailyCampaigns2 = 0;
      }

      while (boxPtr < boxes.length) {
        const boxEndTs = candles5m[boxes[boxPtr].end5mIndex].ts;
        if (c.ts >= boxEndTs) {
          activeBox = boxes[boxPtr];
          boxPtr++;
          continue;
        }
        break;
      }

      // Manage open position (stop/TP/trailing + adds)
      if (pos2 && activeBox) {
        const a5 = activeBox.atr5;
        const boxHigh = activeBox.high;
        const boxLow = activeBox.low;

        const breakBuffer = p.breakBufferAtr5 * a5;
        const stopBuffer = p.stopBufferAtr5 * a5;

        // Stop check
        if (pos2.direction === "LONG") {
          if (c.l <= pos2.stop) {
            closePos2(i, pos2.stop, "STOP");
            continue;
          }
        } else {
          if (c.h >= pos2.stop) {
            closePos2(i, pos2.stop, "STOP");
            continue;
          }
        }

        // --- ADD RULES ---
        // Add #2: breakout add
        const breakoutLong = pos2.direction === "LONG" && c.c > boxHigh + breakBuffer;
        const breakoutShort = pos2.direction === "SHORT" && c.c < boxLow - breakBuffer;

        if ((breakoutLong || breakoutShort) && pos2.qty < p.maxContracts) {
          const addPx = next.o + (pos2.direction === "LONG" ? p.slippagePoints : -p.slippagePoints);
          const nextAvg = weightedAvgPrice(pos2.avgEntry, pos2.qty, addPx, 1);
          // unified stop remains box boundary (or current stop, whichever is tighter)
          const baseStop = pos2.direction === "LONG" ? boxLow - stopBuffer : boxHigh + stopBuffer;
          const unifiedStop = pos2.direction === "LONG" ? Math.max(pos2.stop, baseStop) : Math.min(pos2.stop, baseStop);

          if (canAdd2(nextAvg, pos2.qty + 1, unifiedStop)) {
            pos2.avgEntry = nextAvg;
            pos2.qty += 1;
            pos2.stop = unifiedStop;
            pos2.tags.push("ADD_BREAKOUT");
          }
        }

        // Add #3: retest add
        if (pos2 && pos2.qty < p.maxContracts) {
          if (pos2.direction === "LONG") {
            const retest = c.l <= boxHigh + 0.05 * a5 && c.c > boxHigh;
            if (retest) {
              const addPx = next.o + p.slippagePoints;
              const nextAvg = weightedAvgPrice(pos2.avgEntry, pos2.qty, addPx, 1);
              const baseStop = boxLow - stopBuffer;
              const unifiedStop = Math.max(pos2.stop, baseStop);
              if (canAdd2(nextAvg, pos2.qty + 1, unifiedStop)) {
                pos2.avgEntry = nextAvg;
                pos2.qty += 1;
                pos2.stop = unifiedStop;
                pos2.tags.push("ADD_RETEST");
              }
            }
          } else {
            const retest = c.h >= boxLow - 0.05 * a5 && c.c < boxLow;
            if (retest) {
              const addPx = next.o - p.slippagePoints;
              const nextAvg = weightedAvgPrice(pos2.avgEntry, pos2.qty, addPx, 1);
              const baseStop = boxHigh + stopBuffer;
              const unifiedStop = Math.min(pos2.stop, baseStop);
              if (canAdd2(nextAvg, pos2.qty + 1, unifiedStop)) {
                pos2.avgEntry = nextAvg;
                pos2.qty += 1;
                pos2.stop = unifiedStop;
                pos2.tags.push("ADD_RETEST");
              }
            }
          }
        }

        // Profit mgmt
        const riskPts = pos2.initialRiskPts;
        if (riskPts > 0) {
          const oneR = pos2.direction === "LONG" ? pos2.avgEntry + riskPts : pos2.avgEntry - riskPts;
          const twoR = pos2.direction === "LONG" ? pos2.avgEntry + 2 * riskPts : pos2.avgEntry - 2 * riskPts;

          if (!pos2.hasTaken1R) {
            const hit = pos2.direction === "LONG" ? c.h >= oneR : c.l <= oneR;
            if (hit) {
              partial2(i, oneR, Math.min(1, pos2.qty), "TP_1R");
              pos2.hasTaken1R = true;
              pos2.stop = pos2.avgEntry; // BE
            }
          }

          if (pos2 && !pos2.hasTaken2R) {
            const hit = pos2.direction === "LONG" ? c.h >= twoR : c.l <= twoR;
            if (hit) {
              partial2(i, twoR, Math.min(1, pos2.qty), "TP_2R");
              pos2.hasTaken2R = true;
            }
          }

          if (pos2 && pos2.qty > 0 && pos2.hasTaken1R) {
            if (pos2.direction === "LONG") {
              const trail = minLow(candles1m, i, p.trailLookback);
              pos2.stop = Math.max(pos2.stop, trail);
            } else {
              const trail = maxHigh(candles1m, i, p.trailLookback);
              pos2.stop = Math.min(pos2.stop, trail);
            }
          }

          if (pos2 && pos2.qty === 0) {
            // fully scaled out
            trades2.push({
              direction: pos2.direction,
              entryTs: pos2.entryTs,
              exitTs: c.ts,
              entryPrice: round2(pos2.avgEntry),
              exitPrice: round2(c.c),
              qty: pos2.realizedQty,
              pnl: round2(pos2.realizedPnl),
              rMultiple: round2(pos2.realizedPnl / (p.dollarPerPoint * (pos2.initialRiskPts || 1))),
              tags: [...pos2.tags, "FULL_SCALE_OUT"],
            });
            pos2 = null;
          }
        }

        continue;
      }

      // No position: enforce daily lock
      if (dailyPnl2 <= -Math.abs(p.dailyLossLimit)) continue;
      if (dailyCampaigns2 >= p.maxCampaignsPerDay) continue;
      if (!activeBox) continue;

      const a5 = activeBox.atr5;
      if (!Number.isFinite(a5) || a5 <= 0) continue;

      const boxHigh = activeBox.high;
      const boxLow = activeBox.low;
      const boxMid = activeBox.mid;
      const boxRange = boxHigh - boxLow;

      const stopBuffer = p.stopBufferAtr5 * a5;

      const topBand = boxHigh - p.starterBandPct * boxRange;
      const botBand = boxLow + p.starterBandPct * boxRange;

      const prev = candles1m[i - 1];

      const longStarter =
        c.c >= topBand && c.c <= boxHigh && c.c > boxMid && c.c > prev.h && c.c >= boxLow && c.c <= boxHigh;

      const shortStarter =
        c.c <= botBand && c.c >= boxLow && c.c < boxMid && c.c < prev.l && c.c >= boxLow && c.c <= boxHigh;

      let dir: "LONG" | "SHORT" | null = null;
      if (longStarter) dir = "LONG";
      else if (shortStarter) dir = "SHORT";
      else continue;

      const stop = dir === "LONG" ? boxLow - stopBuffer : boxHigh + stopBuffer;
      const entry = next.o + (dir === "LONG" ? p.slippagePoints : -p.slippagePoints);

      const riskPts = Math.abs(entry - stop);
      const riskDollars1 = riskPts * p.dollarPerPoint;

      if (riskDollars1 > p.riskPerCampaign) continue;

      pos2 = {
        direction: dir,
        qty: 1,
        avgEntry: entry,
        stop,
        initialRiskPts: riskPts,
        hasTaken1R: false,
        hasTaken2R: false,
        tags: ["STARTER"],
        entryTs: next.ts,
        realizedPnl: 0,
        realizedQty: 0,
      };

      dailyCampaigns2 += 1;
    }

    // If position still open at end, close at last close
    if (pos2) {
      const last = candles1m[candles1m.length - 1];
      closePos2(candles1m.length - 1, last.c, "EOD_CLOSE");
    }

    // Summary stats
    const wins = trades2.filter((t) => t.pnl > 0).length;
    const losses = trades2.filter((t) => t.pnl < 0).length;

    const grossProfit = trades2.filter((t) => t.pnl > 0).reduce((s, t) => s + t.pnl, 0);
    const grossLoss = Math.abs(trades2.filter((t) => t.pnl < 0).reduce((s, t) => s + t.pnl, 0));
    const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? 999 : 0;

    // Max drawdown from equity curve
    let peak = 0;
    let maxDd = 0;
    for (const e of equity2) {
      peak = Math.max(peak, e.equity);
      maxDd = Math.min(maxDd, e.equity - peak);
    }

    const summary = {
      netPnl: round2(equityVal2),
      maxDd: round2(maxDd),
      winRate: trades2.length ? round2(wins / trades2.length) : 0,
      trades: trades2.length,
      wins,
      losses,
      profitFactor: round2(profitFactor),
      boxesFound: boxes.length,
      candles1m: candles1m.length,
      candles5m: candles5m.length,
      params: p,
      note: trades2.length
        ? "Backtest complete."
        : "Backtest complete: no trades matched the current rules on this dataset. Consider loosening box constraints or using a different date range.",
    };

    return NextResponse.json({ summary, equity: equity2, trades: trades2 });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? "Server error" }, { status: 500 });
  }
}
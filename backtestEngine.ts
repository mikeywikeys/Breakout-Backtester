// src/lib/backtestEngine.ts

export type Candle = { ts: number; o: number; h: number; l: number; c: number; v?: number };

export type Params = {
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

  // Friction
  slippagePoints: number; // 0
  commissionPerContract: number; // 0

  dollarPerPoint: number; // MGC typically ~10
};

export type Trade = {
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

export type EquityPoint = { ts: number; equity: number };

export type BacktestResult = {
  summary: {
    netPnl: number;
    maxDd: number;
    winRate: number;
    trades: number;
    wins: number;
    losses: number;
    profitFactor: number;
    boxesFound: number;
    candles1m: number;
    candles5m: number;
    params: Params;
    note: string;
  };
  equity: EquityPoint[];
  trades: Trade[];
};

function round2(n: number) {
  return Math.round(n * 100) / 100;
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

    for (let k = start; k <= i; k++) {
      hi = Math.max(hi, c5[k].h);
      lo = Math.min(lo, c5[k].l);
    }

    const range = hi - lo;
    const minR = p.minBoxAtrMult * a;
    const maxR = p.maxBoxAtrMult * a;
    if (range < minR || range > maxR) continue;

    // closes inside range
    let ok = true;
    for (let k = start; k <= i; k++) {
      if (c5[k].c < lo || c5[k].c > hi) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;

    const last = boxes[boxes.length - 1];
    if (last && Math.abs(last.high - hi) < 1e-9 && Math.abs(last.low - lo) < 1e-9) continue;

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

type Position = {
  direction: "LONG" | "SHORT";
  qty: number;
  avgEntry: number;
  stop: number;
  initialRiskPts: number;
  hasTaken1R: boolean;
  hasTaken2R: boolean;
  tags: string[];
  entryTs: number;
  realizedPnl: number;
  realizedQty: number;
};

export function runBacktestLocal(candles1mRaw: Candle[], params: Params): BacktestResult {
  // sanitize & sort
  const candles1m = [...candles1mRaw]
    .filter(
      (c) =>
        Number.isFinite(c.ts) &&
        Number.isFinite(c.o) &&
        Number.isFinite(c.h) &&
        Number.isFinite(c.l) &&
        Number.isFinite(c.c)
    )
    .sort((a, b) => a.ts - b.ts);

  const candles5m = aggregateTo5m(candles1m);
  const atr5 = computeATR(candles5m, params.atrLen5);
  const boxes = findBoxes(candles5m, atr5, params);

  let boxPtr = 0;
  let activeBox: Box | null = null;

  const trades: Trade[] = [];
  const equity: EquityPoint[] = [];
  let equityVal = 0;

  let pos: Position | null = null;

  let dailyPnl = 0;
  let dailyCampaigns = 0;
  let currentDay = dayKeyUTC(candles1m[0]?.ts ?? Date.now());

  function partialExit(i: number, exitPrice: number, qtyExit: number, tag: string) {
    if (!pos) return;
    qtyExit = clamp(qtyExit, 0, pos.qty);
    if (qtyExit <= 0) return;

    const pnl = calcPnl(pos.direction, pos.avgEntry, exitPrice, qtyExit, params.dollarPerPoint, params.commissionPerContract);
    pos.qty -= qtyExit;
    pos.realizedPnl += pnl;
    pos.realizedQty += qtyExit;
    pos.tags.push(tag);

    equityVal += pnl;
    dailyPnl += pnl;
    equity.push({ ts: candles1m[i].ts, equity: round2(equityVal) });
  }

  function closePosition(i: number, exitPrice: number, reason: string) {
    if (!pos) return;
    const exitTs = candles1m[i].ts;

    const qtyToClose = pos.qty;
    const pnl = calcPnl(pos.direction, pos.avgEntry, exitPrice, qtyToClose, params.dollarPerPoint, params.commissionPerContract);

    const rMult =
      pos.initialRiskPts > 0
        ? pos.direction === "LONG"
          ? (exitPrice - pos.avgEntry) / pos.initialRiskPts
          : (pos.avgEntry - exitPrice) / pos.initialRiskPts
        : 0;

    trades.push({
      direction: pos.direction,
      entryTs: pos.entryTs,
      exitTs,
      entryPrice: round2(pos.avgEntry),
      exitPrice: round2(exitPrice),
      qty: qtyToClose + pos.realizedQty,
      pnl: round2(pnl + pos.realizedPnl),
      rMultiple: round2((pos.realizedPnl / (params.dollarPerPoint * (pos.initialRiskPts || 1))) + rMult),
      tags: [...pos.tags, reason],
    });

    equityVal += pnl + pos.realizedPnl;
    dailyPnl += pnl + pos.realizedPnl;
    equity.push({ ts: exitTs, equity: round2(equityVal) });

    pos = null;
  }

  function canAdd(nextAvg: number, nextQty: number, stop: number): boolean {
    const riskPts = Math.abs(nextAvg - stop);
    const risk = nextQty * riskPts * params.dollarPerPoint;
    return risk <= params.riskPerCampaign + 1e-9;
  }

  for (let i = 2; i < candles1m.length - 1; i++) {
    const c = candles1m[i];
    const next = candles1m[i + 1];

    // daily reset
    const dkey = dayKeyUTC(c.ts);
    if (dkey !== currentDay) {
      currentDay = dkey;
      dailyPnl = 0;
      dailyCampaigns = 0;
    }

    // update active box
    while (boxPtr < boxes.length) {
      const boxEndTs = candles5m[boxes[boxPtr].end5mIndex].ts;
      if (c.ts >= boxEndTs) {
        activeBox = boxes[boxPtr];
        boxPtr++;
        continue;
      }
      break;
    }

    // manage open position
    if (pos && activeBox) {
      const a5 = activeBox.atr5;
      const boxHigh = activeBox.high;
      const boxLow = activeBox.low;

      const breakBuffer = params.breakBufferAtr5 * a5;
      const stopBuffer = params.stopBufferAtr5 * a5;

      // stop
      if (pos.direction === "LONG" && c.l <= pos.stop) {
        closePosition(i, pos.stop, "STOP");
        continue;
      }
      if (pos.direction === "SHORT" && c.h >= pos.stop) {
        closePosition(i, pos.stop, "STOP");
        continue;
      }

      // ADD #2: breakout add
      const breakoutLong = pos.direction === "LONG" && c.c > boxHigh + breakBuffer;
      const breakoutShort = pos.direction === "SHORT" && c.c < boxLow - breakBuffer;

      if ((breakoutLong || breakoutShort) && pos.qty < params.maxContracts) {
        const addPx = next.o + (pos.direction === "LONG" ? params.slippagePoints : -params.slippagePoints);
        const nextAvg = weightedAvgPrice(pos.avgEntry, pos.qty, addPx, 1);
        const baseStop = pos.direction === "LONG" ? boxLow - stopBuffer : boxHigh + stopBuffer;
        const unifiedStop = pos.direction === "LONG" ? Math.max(pos.stop, baseStop) : Math.min(pos.stop, baseStop);

        if (canAdd(nextAvg, pos.qty + 1, unifiedStop)) {
          pos.avgEntry = nextAvg;
          pos.qty += 1;
          pos.stop = unifiedStop;
          pos.tags.push("ADD_BREAKOUT");
        }
      }

      // ADD #3: retest add
      if (pos && pos.qty < params.maxContracts) {
        if (pos.direction === "LONG") {
          const retest = c.l <= boxHigh + 0.05 * a5 && c.c > boxHigh;
          if (retest) {
            const addPx = next.o + params.slippagePoints;
            const nextAvg = weightedAvgPrice(pos.avgEntry, pos.qty, addPx, 1);
            const baseStop = boxLow - stopBuffer;
            const unifiedStop = Math.max(pos.stop, baseStop);
            if (canAdd(nextAvg, pos.qty + 1, unifiedStop)) {
              pos.avgEntry = nextAvg;
              pos.qty += 1;
              pos.stop = unifiedStop;
              pos.tags.push("ADD_RETEST");
            }
          }
        } else {
          const retest = c.h >= boxLow - 0.05 * a5 && c.c < boxLow;
          if (retest) {
            const addPx = next.o - params.slippagePoints;
            const nextAvg = weightedAvgPrice(pos.avgEntry, pos.qty, addPx, 1);
            const baseStop = boxHigh + stopBuffer;
            const unifiedStop = Math.min(pos.stop, baseStop);
            if (canAdd(nextAvg, pos.qty + 1, unifiedStop)) {
              pos.avgEntry = nextAvg;
              pos.qty += 1;
              pos.stop = unifiedStop;
              pos.tags.push("ADD_RETEST");
            }
          }
        }
      }

      // profit mgmt
      const riskPts = pos.initialRiskPts;
      if (riskPts > 0) {
        const oneR = pos.direction === "LONG" ? pos.avgEntry + riskPts : pos.avgEntry - riskPts;
        const twoR = pos.direction === "LONG" ? pos.avgEntry + 2 * riskPts : pos.avgEntry - 2 * riskPts;

        if (!pos.hasTaken1R) {
          const hit = pos.direction === "LONG" ? c.h >= oneR : c.l <= oneR;
          if (hit) {
            partialExit(i, oneR, Math.min(1, pos.qty), "TP_1R");
            pos.hasTaken1R = true;
            pos.stop = pos.avgEntry; // BE
          }
        }

        if (pos && !pos.hasTaken2R) {
          const hit = pos.direction === "LONG" ? c.h >= twoR : c.l <= twoR;
          if (hit) {
            partialExit(i, twoR, Math.min(1, pos.qty), "TP_2R");
            pos.hasTaken2R = true;
          }
        }

        if (pos && pos.qty > 0 && pos.hasTaken1R) {
          if (pos.direction === "LONG") {
            const trail = minLow(candles1m, i, params.trailLookback);
            pos.stop = Math.max(pos.stop, trail);
          } else {
            const trail = maxHigh(candles1m, i, params.trailLookback);
            pos.stop = Math.min(pos.stop, trail);
          }
        }

        // fully scaled out
        if (pos && pos.qty === 0) {
          trades.push({
            direction: pos.direction,
            entryTs: pos.entryTs,
            exitTs: c.ts,
            entryPrice: round2(pos.avgEntry),
            exitPrice: round2(c.c),
            qty: pos.realizedQty,
            pnl: round2(pos.realizedPnl),
            rMultiple: round2(pos.realizedPnl / (params.dollarPerPoint * (pos.initialRiskPts || 1))),
            tags: [...pos.tags, "FULL_SCALE_OUT"],
          });
          pos = null;
        }
      }

      continue;
    }

    // no position: daily lock
    if (dailyPnl <= -Math.abs(params.dailyLossLimit)) continue;
    if (dailyCampaigns >= params.maxCampaignsPerDay) continue;
    if (!activeBox) continue;

    const a5 = activeBox.atr5;
    if (!Number.isFinite(a5) || a5 <= 0) continue;

    const boxHigh = activeBox.high;
    const boxLow = activeBox.low;
    const boxMid = activeBox.mid;
    const boxRange = boxHigh - boxLow;

    const stopBuffer = params.stopBufferAtr5 * a5;
    const topBand = boxHigh - params.starterBandPct * boxRange;
    const botBand = boxLow + params.starterBandPct * boxRange;

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
    const entry = next.o + (dir === "LONG" ? params.slippagePoints : -params.slippagePoints);

    const riskPts = Math.abs(entry - stop);
    const riskDollars1 = riskPts * params.dollarPerPoint;
    if (riskDollars1 > params.riskPerCampaign) continue;

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
  }

  // close open position at end
  if (pos) {
    const last = candles1m[candles1m.length - 1];
    closePosition(candles1m.length - 1, last.c, "EOD_CLOSE");
  }

  const wins = trades.filter((t) => t.pnl > 0).length;
  const losses = trades.filter((t) => t.pnl < 0).length;

  const grossProfit = trades.filter((t) => t.pnl > 0).reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(trades.filter((t) => t.pnl < 0).reduce((s, t) => s + t.pnl, 0));
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? 999 : 0;

  let peak = 0;
  let maxDd = 0;
  for (const e of equity) {
    peak = Math.max(peak, e.equity);
    maxDd = Math.min(maxDd, e.equity - peak);
  }

  const summary = {
    netPnl: round2(equityVal),
    maxDd: round2(maxDd),
    winRate: trades.length ? round2(wins / trades.length) : 0,
    trades: trades.length,
    wins,
    losses,
    profitFactor: round2(profitFactor),
    boxesFound: boxes.length,
    candles1m: candles1m.length,
    candles5m: candles5m.length,
    params,
    note: trades.length
      ? "Backtest complete."
      : "Backtest complete: no trades matched the current rules. Try loosening parameters or using a different date range.",
  };

  return { summary, equity, trades };
}
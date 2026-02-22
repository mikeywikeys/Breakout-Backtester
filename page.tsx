// src/app/page.tsx
"use client";

import React, { useMemo, useRef, useState, useEffect } from "react";
import { createPortal } from "react-dom";
import Papa from "papaparse";
import { ResponsiveContainer, LineChart, Line, XAxis, YAxis, Tooltip, CartesianGrid } from "recharts";
import { runBacktestLocal, type Candle, type Params, type BacktestResult, type Trade } from "./lib/backtestEngine";

/* ===================== Types ===================== */

type ImportMeta = {
  detectedFormat: "APP_NATIVE" | "NT8_DATETIME" | "NT8_DATE_TIME";
  rowsParsed: number;
  warnings: string[];
  header: string[];
  delimiter: "comma" | "tab" | "semicolon";
};

type Filters = {
  direction: "ALL" | "LONG" | "SHORT";
  outcome: "ALL" | "WINS" | "LOSSES";
  tagQuery: string;
  dateStartUtc: string;
  dateEndUtc: string;
  minPnl: string;
  maxPnl: string;
};

/* ===================== Helpers ===================== */

function downloadTextFile(filename: string, text: string) {
  const blob = new Blob([text], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function toStandardCsv(candles: Candle[]) {
  const lines = ["ts,o,h,l,c,v"];
  for (const x of candles) lines.push([x.ts, x.o, x.h, x.l, x.c, x.v ?? ""].join(","));
  return lines.join("\n");
}

function parseNt8DateTime(dateStr: string, timeStr?: string): number | null {
  const d = (dateStr ?? "").trim();
  const t = (timeStr ?? "").trim();

  if (!timeStr) {
    const parts = d.split(/\s+/).filter(Boolean);
    if (parts.length === 2 && /^\d{8}$/.test(parts[0]) && /^\d{4,6}$/.test(parts[1])) {
      return parseNt8DateTime(parts[0], parts[1]);
    }
    const quick = Date.parse(d);
    if (Number.isFinite(quick)) return quick;
    return null;
  }

  if (!/^\d{8}$/.test(d)) return null;

  const yyyy = Number(d.slice(0, 4));
  const MM = Number(d.slice(4, 6));
  const dd = Number(d.slice(6, 8));

  let HH = 0, mm = 0, ss = 0;

  if (/^\d{6}$/.test(t)) {
    HH = Number(t.slice(0, 2));
    mm = Number(t.slice(2, 4));
    ss = Number(t.slice(4, 6));
  } else if (/^\d{4}$/.test(t)) {
    HH = Number(t.slice(0, 2));
    mm = Number(t.slice(2, 4));
  } else {
    return null;
  }

  return Date.UTC(yyyy, MM - 1, dd, HH, mm, ss);
}

function inferDelimiter(text: string): { delimiter: "," | "\t" | ";"; label: ImportMeta["delimiter"] } {
  const firstLine = text.split(/\r?\n/).find((l) => l.trim().length > 0) ?? "";
  const commaCount = (firstLine.match(/,/g) ?? []).length;
  const tabCount = (firstLine.match(/\t/g) ?? []).length;
  const semiCount = (firstLine.match(/;/g) ?? []).length;

  const max = Math.max(commaCount, tabCount, semiCount);
  if (max === tabCount) return { delimiter: "\t", label: "tab" };
  if (max === semiCount) return { delimiter: ";", label: "semicolon" };
  return { delimiter: ",", label: "comma" };
}

function looksLikeNt8NoHeader(firstLine: string, delim: "," | "\t" | ";"): boolean {
  const parts = firstLine.split(delim).map((x) => x.trim());
  if (parts.length < 6) return false;
  const dtOk = /^\d{8}\s+\d{4,6}$/.test(parts[0]);
  const numsOk =
    Number.isFinite(Number(parts[1])) &&
    Number.isFinite(Number(parts[2])) &&
    Number.isFinite(Number(parts[3])) &&
    Number.isFinite(Number(parts[4])) &&
    Number.isFinite(Number(parts[5]));
  return dtOk && numsOk;
}

function parseNt8NoHeaderRows(rows: any[][]): Candle[] {
  const out: Candle[] = [];
  for (const r of rows) {
    const cols = r.map((x) => (x == null ? "" : String(x).trim()));
    if (cols.length < 6) continue;

    const ts = parseNt8DateTime(cols[0]);
    if (ts == null) continue;

    const o = Number(cols[1]);
    const h = Number(cols[2]);
    const l = Number(cols[3]);
    const c = Number(cols[4]);
    const v = Number(cols[5]);

    if (![o, h, l, c].every((n) => Number.isFinite(n))) continue;
    out.push({ ts, o, h, l, c, v: Number.isFinite(v) ? v : undefined });
  }
  out.sort((a, b) => a.ts - b.ts);
  return out;
}

function fmtUtc(ts: number): string {
  return new Date(ts).toISOString().replace("T", " ").replace("Z", " UTC");
}

function formatMoney(n: number) {
  const sign = n < 0 ? "-" : "";
  return `${sign}$${Math.abs(n).toFixed(2)}`;
}

function formatPct(n: number) {
  return `${(n * 100).toFixed(1)}%`;
}

function toUtcDateInput(ts: number): string {
  const d = new Date(ts);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function dateInputToUtcRangeStartMs(v: string): number | null {
  if (!v) return null;
  const [y, m, d] = v.split("-").map(Number);
  if (![y, m, d].every(Number.isFinite)) return null;
  return Date.UTC(y, m - 1, d, 0, 0, 0);
}

function dateInputToUtcRangeEndMs(v: string): number | null {
  if (!v) return null;
  const [y, m, d] = v.split("-").map(Number);
  if (![y, m, d].every(Number.isFinite)) return null;
  return Date.UTC(y, m - 1, d, 23, 59, 59, 999);
}

/* ===================== UI bits ===================== */

function StatCard({
  label,
  value,
  hint,
  accent = "neutral",
}: {
  label: string;
  value: string;
  hint?: string;
  accent?: "good" | "bad" | "neutral";
}) {
  const border =
    accent === "good"
      ? "rgba(57,255,20,0.28)"
      : accent === "bad"
      ? "rgba(255,90,90,0.28)"
      : "rgba(57,255,20,0.16)";

  const bg =
    accent === "good"
      ? "rgba(57,255,20,0.06)"
      : accent === "bad"
      ? "rgba(255,90,90,0.05)"
      : "rgba(0,0,0,0.20)";

  return (
    <div style={{ borderRadius: 16, border: `1px solid ${border}`, background: bg, padding: 14, minHeight: 78, display: "flex", flexDirection: "column", justifyContent: "space-between" }}>
      <div style={{ fontSize: 12, opacity: 0.75 }}>{label}</div>
      <div style={{ fontSize: 20, fontWeight: 900, letterSpacing: -0.3 }}>{value}</div>
      {hint ? <div style={{ fontSize: 12, opacity: 0.65 }}>{hint}</div> : <div />}
    </div>
  );
}

function InfoTip({ text }: { text: string }) {
  const iconRef = useRef<HTMLSpanElement | null>(null);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  function clamp(n: number, lo: number, hi: number) {
    return Math.max(lo, Math.min(hi, n));
  }

  function recalc() {
    const el = iconRef.current;
    if (!el) return;

    const r = el.getBoundingClientRect();
    const padding = 10;
    const maxW = Math.min(340, window.innerWidth * 0.7);
    const estimatedW = maxW;

    let left = r.left + 22;
    left = Math.min(left, window.innerWidth - estimatedW - padding);
    left = clamp(left, padding, window.innerWidth - estimatedW - padding);

    let top = r.bottom + 10;
    const estH = 90;
    if (top + estH > window.innerHeight - padding) {
      top = r.top - 10 - estH;
      top = clamp(top, padding, window.innerHeight - estH - padding);
    }

    setPos({ left, top });
  }

  useEffect(() => {
    if (!open) return;
    recalc();
    const onScroll = () => recalc();
    const onResize = () => recalc();
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onResize);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  return (
    <>
      <span
        ref={iconRef}
        style={infoIconStyle}
        tabIndex={0}
        aria-label="info"
        onMouseEnter={() => {
          setOpen(true);
          recalc();
        }}
        onMouseLeave={() => setOpen(false)}
        onFocus={() => {
          setOpen(true);
          recalc();
        }}
        onBlur={() => setOpen(false)}
      >
        ⓘ
      </span>

      {open && pos && typeof document !== "undefined"
        ? createPortal(
            <div style={{ ...tooltipFixedStyle, left: pos.left, top: pos.top }} role="tooltip">
              {text}
            </div>,
            document.body
          )
        : null}
    </>
  );
}

function LabeledInput({
  label,
  value,
  onChange,
  step,
  min,
  max,
  info,
}: {
  label: string;
  value: number;
  onChange: (n: number) => void;
  step?: number;
  min?: number;
  max?: number;
  info?: string;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <div style={{ fontSize: 12, opacity: 0.85, display: "flex", gap: 8, alignItems: "center" }}>
        <span>{label}</span>
        {info ? <InfoTip text={info} /> : null}
      </div>
      <input type="number" value={Number.isFinite(value) ? value : 0} step={step} min={min} max={max} onChange={(e) => onChange(Number(e.target.value))} style={inputStyle} />
    </div>
  );
}

function Select({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (v: any) => void;
  options: { value: string; label: string }[];
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <div style={{ fontSize: 12, opacity: 0.8 }}>{label}</div>
      <select value={value} onChange={(e) => onChange(e.target.value)} style={inputStyle}>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  );
}

/* ===================== Page ===================== */

export default function Home() {
  const [rawFile, setRawFile] = useState<File | null>(null);
  const [importMeta, setImportMeta] = useState<ImportMeta | null>(null);
  const [candles1m, setCandles1m] = useState<Candle[] | null>(null);
  const [result, setResult] = useState<BacktestResult | null>(null);
  const [loading, setLoading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const [params, setParams] = useState<Params>({
    riskPerCampaign: 200,
    maxCampaignsPerDay: 2,
    dailyLossLimit: 400,
    maxContracts: 3,
    boxBars: 6,
    atrLen5: 20,
    atrLen1: 14,
    minBoxAtrMult: 0.6,
    maxBoxAtrMult: 1.6,
    breakBufferAtr5: 0.1,
    stopBufferAtr5: 0.1,
    starterBandPct: 0.25,
    trailLookback: 8,
    slippagePoints: 0,
    commissionPerContract: 0,
    dollarPerPoint: 10,
  });

  const [filters, setFilters] = useState<Filters>({
    direction: "ALL",
    outcome: "ALL",
    tagQuery: "",
    dateStartUtc: "",
    dateEndUtc: "",
    minPnl: "",
    maxPnl: "",
  });

  const fileLabel = useMemo(() => {
    if (!rawFile) return "Upload NT8 1-minute historical file (.txt or .csv) — we auto-format it";
    return `Selected: ${rawFile.name}`;
  }, [rawFile]);

  const overview = useMemo(() => {
    if (!candles1m?.length) return null;
    return { startFmt: fmtUtc(candles1m[0].ts), endFmt: fmtUtc(candles1m[candles1m.length - 1].ts) };
  }, [candles1m]);

  useEffect(() => {
    if (!candles1m?.length) return;
    const start = toUtcDateInput(candles1m[0].ts);
    const end = toUtcDateInput(candles1m[candles1m.length - 1].ts);
    setFilters((f) => ({ ...f, dateStartUtc: f.dateStartUtc || start, dateEndUtc: f.dateEndUtc || end }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [candles1m?.length]);

  const equityForChart = useMemo(() => {
    if (!result?.equity?.length) return [];
    const eq = result.equity;
    const maxPoints = 600;
    if (eq.length <= maxPoints) return eq;
    const step = Math.ceil(eq.length / maxPoints);
    const sampled: { ts: number; equity: number }[] = [];
    for (let i = 0; i < eq.length; i += step) sampled.push(eq[i]);
    return sampled;
  }, [result]);

  async function handleUpload(file: File) {
    setRawFile(file);
    setResult(null);
    setCandles1m(null);
    setImportMeta(null);

    const text = await file.text();
    const inferred = inferDelimiter(text);
    const firstLine = text.split(/\r?\n/).find((l) => l.trim().length > 0) ?? "";

    if (looksLikeNt8NoHeader(firstLine, inferred.delimiter)) {
      const parsedNoHeader = Papa.parse<any[]>(text, {
        header: false,
        skipEmptyLines: true,
        dynamicTyping: false,
        delimiter: inferred.delimiter,
      });

      const out = parseNt8NoHeaderRows(parsedNoHeader.data as any[][]);
      const dropped = Math.max(0, (parsedNoHeader.data?.length ?? 0) - out.length);

      setImportMeta({
        detectedFormat: "NT8_DATETIME",
        rowsParsed: out.length,
        warnings: [
          "Detected NT8 no-header format: yyyyMMdd HHmmss;Open;High;Low;Close;Volume",
          dropped > 0 ? `Dropped ${dropped} rows that couldn’t be parsed.` : "",
        ].filter(Boolean),
        header: [],
        delimiter: inferred.label,
      });

      setCandles1m(out);
      return;
    }

    setImportMeta({
      detectedFormat: "NT8_DATETIME",
      rowsParsed: 0,
      warnings: [
        "This file doesn’t match the expected NT8 no-header OHLCV format.",
        "Expected: yyyyMMdd HHmmss;Open;High;Low;Close;Volume",
      ],
      header: [],
      delimiter: inferred.label,
    });
    setCandles1m([]);
  }

  async function runBacktest() {
    if (!candles1m || candles1m.length < 50) {
      alert("Not enough candles parsed. Upload a valid NT8 1-minute OHLCV file first.");
      return;
    }

    setLoading(true);
    setResult(null);

    // Let the UI paint the loading state before heavy compute
    await new Promise((r) => setTimeout(r, 0));

    try {
      const data = runBacktestLocal(candles1m, params);
      setResult(data);
    } catch (e: any) {
      alert(e.message ?? String(e));
    } finally {
      setLoading(false);
    }
  }

  function downloadFormatted() {
    if (!candles1m?.length) return;
    const csv = toStandardCsv(candles1m);
    const base = rawFile?.name?.replace(/\.(csv|txt)$/i, "") ?? "nt8_export";
    downloadTextFile(`${base}.formatted.csv`, csv);
  }

  const summary = result?.summary ?? null;
  const trades = result?.trades ?? [];

  const filteredTrades = useMemo(() => {
    const startMs = dateInputToUtcRangeStartMs(filters.dateStartUtc);
    const endMs = dateInputToUtcRangeEndMs(filters.dateEndUtc);
    const minPnl = filters.minPnl.trim() ? Number(filters.minPnl) : null;
    const maxPnl = filters.maxPnl.trim() ? Number(filters.maxPnl) : null;
    const q = filters.tagQuery.trim().toLowerCase();

    return trades.filter((t) => {
      if (filters.direction !== "ALL" && t.direction !== filters.direction) return false;
      if (filters.outcome === "WINS" && t.pnl <= 0) return false;
      if (filters.outcome === "LOSSES" && t.pnl >= 0) return false;

      if (startMs != null && t.entryTs < startMs) return false;
      if (endMs != null && t.entryTs > endMs) return false;

      if (minPnl != null && Number.isFinite(minPnl) && t.pnl < minPnl) return false;
      if (maxPnl != null && Number.isFinite(maxPnl) && t.pnl > maxPnl) return false;

      if (q) {
        const tagText = (t.tags ?? []).join(" ").toLowerCase();
        if (!tagText.includes(q)) return false;
      }
      return true;
    });
  }, [trades, filters]);

  const filteredStats = useMemo(() => {
    const n = filteredTrades.length;
    if (!n) return { winRate: 0, net: 0 };
    const wins = filteredTrades.filter((t) => t.pnl > 0).length;
    const net = filteredTrades.reduce((s, t) => s + t.pnl, 0);
    return { winRate: wins / n, net };
  }, [filteredTrades]);

  return (
    <div style={pageStyle}>
      <div style={containerStyle}>
        <div style={headerRowStyle}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 14, flexWrap: "wrap" }}>
            <h1 style={h1Style}>Breakout Backtester</h1>
            <span style={pillStyle}>Breakout • Scale + Trail</span>
          </div>
        </div>


        <div style={cardStyle}>
          <div style={cardTopGlowStyle} />
          <div style={cardInnerStyle}>
            <div style={topControlsGrid}>
              <div style={uploadBlockStyle}>
                <div style={labelTitleStyle}>Upload</div>
                <div style={labelSubStyle}>
                  Upload the raw NT8 <code style={codeStyle}>.txt</code>. We auto-format it to{" "}
                  <code style={codeStyle}>ts,o,h,l,c,v</code>.
                </div>

                <div style={uploadRowStyle}>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept=".csv,.txt,text/plain"
                    style={{ display: "none" }}
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f) void handleUpload(f);
                    }}
                  />

                  <button type="button" onClick={() => fileInputRef.current?.click()} style={fileBtnStyle}>
                    {rawFile ? "Change NT8 File" : "Upload NT8 1-Minute Historical File (.txt/.csv)"}
                  </button>

                  <div style={fileMetaStyle}>
                    <div style={{ fontSize: 13, opacity: 0.92 }}>{fileLabel}</div>
                    {importMeta ? (
                      <div style={{ fontSize: 12, opacity: 0.72 }}>
                        Detected: <b>{importMeta.detectedFormat}</b> • Delimiter: <b>{importMeta.delimiter}</b> •
                        Parsed: <b>{importMeta.rowsParsed}</b> rows
                      </div>
                    ) : (
                      <div style={{ fontSize: 12, opacity: 0.72 }}>We’ll format it automatically after upload.</div>
                    )}
                    {overview ? (
                      <div style={{ fontSize: 12, opacity: 0.72, marginTop: 6 }}>
                        Data range: <b>{overview.startFmt}</b> → <b>{overview.endFmt}</b>
                      </div>
                    ) : null}
                  </div>
                </div>

                {importMeta?.warnings?.length ? (
                  <div style={{ marginTop: 12, fontSize: 12, opacity: 0.78, lineHeight: 1.5 }}>
                    {importMeta.warnings.map((w, i) => (
                      <div key={i}>• {w}</div>
                    ))}
                  </div>
                ) : null}

                {candles1m?.length ? (
                  <div style={{ marginTop: 14, display: "flex", gap: 12, flexWrap: "wrap" }}>
                    <button type="button" onClick={downloadFormatted} style={secondaryBtnStyle}>
                      Download Formatted CSV
                    </button>
                    <div style={{ fontSize: 12, opacity: 0.7, alignSelf: "center" }}>
                      Outputs: <code style={codeStyle}>ts,o,h,l,c,v</code>
                    </div>
                  </div>
                ) : null}
              </div>

              <div style={runBlockStyle}>
                <div>
                  <div style={labelTitleStyle}>
                    Risk: <code style={codeStyle}>${params.riskPerCampaign}</code> | Trades/day: <code style={codeStyle}>{params.maxCampaignsPerDay}</code>
                  </div>
                </div>

                <button onClick={runBacktest} disabled={!candles1m?.length || loading} style={runBtnStyle(!candles1m?.length || loading)}>
                  {loading ? "Running..." : "Run Backtest"}
                </button>

                <div style={{ fontSize: 12, opacity: 0.68, marginTop: 10, lineHeight: 1.5 }}>
                  Tip: very large files may take a few seconds.
                </div>
              </div>
            </div>

            <div style={dividerStyle} />

            <div style={contentGrid}>
              {/* LEFT */}
              <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
                <div style={panelStyle}>
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
                    <div style={{ fontSize: 16, fontWeight: 900 }}>Results</div>
                    {summary?.note ? <div style={{ fontSize: 12, opacity: 0.7 }}>{summary.note}</div> : null}
                  </div>

                  {!result ? (
                    <div style={{ marginTop: 10, fontSize: 13, opacity: 0.85 }}>
                      No backtest run yet. Upload your file and click <b>Run Backtest</b>.
                    </div>
                  ) : (
                    <>
                      <div style={kpiGrid}>
                        <StatCard label="Net PnL" value={formatMoney(summary!.netPnl)} accent={summary!.netPnl > 0 ? "good" : summary!.netPnl < 0 ? "bad" : "neutral"} />
                        <StatCard label="Max Drawdown" value={formatMoney(summary!.maxDd)} accent={summary!.maxDd < 0 ? "bad" : "neutral"} />
                        <StatCard label="Win Rate" value={formatPct(summary!.winRate)} />
                        <StatCard label="Profit Factor" value={summary!.profitFactor.toFixed(2)} />
                        <StatCard label="Trades" value={String(summary!.trades)} hint={`Boxes: ${summary!.boxesFound}`} />
                        <StatCard label="Bars" value={`${summary!.candles1m} (1m)`} hint={`${summary!.candles5m} (5m)`} />
                      </div>

                      <div style={chartPanelStyle}>
                        <div style={{ display: "flex", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
                          <div style={{ fontSize: 14, fontWeight: 900 }}>Equity Curve</div>
                          <div style={{ fontSize: 12, opacity: 0.7 }}>{result.equity.length ? `${result.equity.length} points` : "No equity points"}</div>
                        </div>

                        {!result.equity.length ? (
                          <div style={{ marginTop: 10, fontSize: 13, opacity: 0.85 }}>
                            No equity points were generated. This usually means no trades were closed.
                          </div>
                        ) : (
                          <div style={{ marginTop: 10, height: 280 }}>
                            <ResponsiveContainer width="100%" height="100%">
                              <LineChart data={equityForChart}>
                                <CartesianGrid stroke="rgba(57,255,20,0.10)" />
                                <XAxis
                                  dataKey="ts"
                                  tickFormatter={(v) => {
                                    const d = new Date(v);
                                    return `${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
                                  }}
                                  stroke="rgba(234,251,234,0.65)"
                                />
                                <YAxis stroke="rgba(234,251,234,0.65)" />
                                <Tooltip
                                  formatter={(val: any) => [`${val}`, "Equity"]}
                                  labelFormatter={(label: any) => fmtUtc(Number(label))}
                                  contentStyle={{ background: "rgba(0,0,0,0.85)", border: "1px solid rgba(57,255,20,0.25)", borderRadius: 12 }}
                                  itemStyle={{ color: "rgba(234,251,234,0.95)" }}
                                  labelStyle={{ color: "rgba(234,251,234,0.85)" }}
                                />
                                <Line type="monotone" dataKey="equity" stroke="rgba(57,255,20,0.95)" strokeWidth={2} dot={false} />
                              </LineChart>
                            </ResponsiveContainer>
                          </div>
                        )}
                      </div>
                    </>
                  )}
                </div>

                <div style={panelStyle}>
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
                    <div style={{ fontSize: 16, fontWeight: 900 }}>Trades</div>
                    {result ? (
                      <div style={{ fontSize: 12, opacity: 0.7 }}>
                        Showing {Math.min(filteredTrades.length, 200)} / {filteredTrades.length} (filtered) • Filtered Net:{" "}
                        <b>{formatMoney(filteredStats.net)}</b> • Filtered WinRate: <b>{formatPct(filteredStats.winRate)}</b>
                      </div>
                    ) : null}
                  </div>

                  {!result ? (
                    <div style={{ marginTop: 10, fontSize: 13, opacity: 0.85 }}>Run a backtest to see trades.</div>
                  ) : filteredTrades.length === 0 ? (
                    <div style={{ marginTop: 10, fontSize: 13, opacity: 0.85 }}>No trades match the current filters.</div>
                  ) : (
                    <div style={tableWrapStyle}>
                      <table style={tableStyle}>
                        <thead>
                          <tr style={tableHeaderRowStyle}>
                            {["Dir", "Entry (UTC)", "Exit (UTC)", "Qty", "Entry", "Exit", "PnL", "R", "Tags"].map((h) => (
                              <th key={h} style={thStyle}>
                                {h}
                              </th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {filteredTrades.slice(0, 200).map((t, idx) => {
                            const pnlAccent =
                              t.pnl > 0 ? "rgba(57,255,20,0.9)" : t.pnl < 0 ? "rgba(255,90,90,0.9)" : "rgba(234,251,234,0.75)";
                            return (
                              <tr key={idx} style={{ borderBottom: "1px solid rgba(57,255,20,0.08)" }}>
                                <td style={tdStyleStrong}>{t.direction}</td>
                                <td style={tdStyleMono}>{fmtUtc(t.entryTs)}</td>
                                <td style={tdStyleMono}>{fmtUtc(t.exitTs)}</td>
                                <td style={tdStyle}>{t.qty}</td>
                                <td style={tdStyle}>{t.entryPrice}</td>
                                <td style={tdStyle}>{t.exitPrice}</td>
                                <td style={{ ...tdStyle, color: pnlAccent, fontWeight: 900 }}>{formatMoney(t.pnl)}</td>
                                <td style={tdStyle}>{(t.rMultiple ?? 0).toFixed(2)}</td>
                                <td style={{ ...tdStyle, opacity: 0.85, maxWidth: 420 }}>{t.tags?.join(", ")}</td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              </div>

              {/* RIGHT */}
              <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
                <div style={panelStyle}>
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
                    <div style={{ fontSize: 16, fontWeight: 900 }}>Parameters</div>
                    <div style={{ fontSize: 12, opacity: 0.7 }}>Hover ⓘ</div>
                  </div>

                  <div style={{ marginTop: 14, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                    <LabeledInput label="Risk per Campaign ($)" value={params.riskPerCampaign} onChange={(v) => setParams((p) => ({ ...p, riskPerCampaign: v }))} step={10} min={0} info="Max $ you risk on the entire position (starter + adds)." />
                    <LabeledInput label="Daily Loss Limit ($)" value={params.dailyLossLimit} onChange={(v) => setParams((p) => ({ ...p, dailyLossLimit: v }))} step={10} min={0} info="Stops taking new campaigns after daily realized PnL drops below -this amount." />
                    <LabeledInput label="Max Campaigns / Day" value={params.maxCampaignsPerDay} onChange={(v) => setParams((p) => ({ ...p, maxCampaignsPerDay: v }))} step={1} min={0} info="Number of separate attempts per day (starter entries)." />
                    <LabeledInput label="Max Contracts" value={params.maxContracts} onChange={(v) => setParams((p) => ({ ...p, maxContracts: v }))} step={1} min={1} info="Maximum size after scaling in." />

                    <LabeledInput label="Box Bars (5m)" value={params.boxBars} onChange={(v) => setParams((p) => ({ ...p, boxBars: v }))} step={1} min={3} info="How many 5m candles define the accumulation box." />
                    <LabeledInput label="ATR Len (5m)" value={params.atrLen5} onChange={(v) => setParams((p) => ({ ...p, atrLen5: v }))} step={1} min={2} info="ATR period on 5m candles for box sizing and buffers." />
                    <LabeledInput label="Min Box Range (ATR mult)" value={params.minBoxAtrMult} onChange={(v) => setParams((p) => ({ ...p, minBoxAtrMult: v }))} step={0.1} min={0} info="Minimum box height = this * ATR5." />
                    <LabeledInput label="Max Box Range (ATR mult)" value={params.maxBoxAtrMult} onChange={(v) => setParams((p) => ({ ...p, maxBoxAtrMult: v }))} step={0.1} min={0} info="Maximum box height = this * ATR5." />

                    <LabeledInput label="Break Buffer (ATR5 frac)" value={params.breakBufferAtr5} onChange={(v) => setParams((p) => ({ ...p, breakBufferAtr5: v }))} step={0.01} min={0} info="Extra distance beyond the box to confirm a breakout (filters fakeouts)." />
                    <LabeledInput label="Stop Buffer (ATR5 frac)" value={params.stopBufferAtr5} onChange={(v) => setParams((p) => ({ ...p, stopBufferAtr5: v }))} step={0.01} min={0} info="Extra distance beyond the box boundary for the stop." />
                    <LabeledInput label="Starter Band %" value={params.starterBandPct} onChange={(v) => setParams((p) => ({ ...p, starterBandPct: v }))} step={0.05} min={0} max={0.5} info="Starter entries only in the top/bottom % of the box (0.25 = 25%)." />
                    <LabeledInput label="Trail Lookback (1m)" value={params.trailLookback} onChange={(v) => setParams((p) => ({ ...p, trailLookback: v }))} step={1} min={1} info="Trailing stop uses last N 1m lows/highs after 1R." />

                    <LabeledInput label="Slippage (points)" value={params.slippagePoints} onChange={(v) => setParams((p) => ({ ...p, slippagePoints: v }))} step={0.1} min={0} info="Assumed worse fill per entry/add in points." />
                    <LabeledInput label="Commission / contract ($)" value={params.commissionPerContract} onChange={(v) => setParams((p) => ({ ...p, commissionPerContract: v }))} step={0.1} min={0} info="Commission per side per contract (engine applies round-trip)." />
                    <LabeledInput label="Dollar per Point" value={params.dollarPerPoint} onChange={(v) => setParams((p) => ({ ...p, dollarPerPoint: v }))} step={1} min={0} info="Profit/Loss per 1.0 price move per contract." />
                    <LabeledInput label="ATR Len (1m)" value={params.atrLen1} onChange={(v) => setParams((p) => ({ ...p, atrLen1: v }))} step={1} min={2} info="Reserved for future refinements using 1m volatility." />
                  </div>
                </div>

                <div style={panelStyle}>
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
                    <div style={{ fontSize: 16, fontWeight: 900 }}>Filters</div>
                    <div style={{ fontSize: 12, opacity: 0.7 }}>Table only</div>
                  </div>

                  <div style={{ marginTop: 14, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                    <Select
                      label="Direction"
                      value={filters.direction}
                      onChange={(v) => setFilters((f) => ({ ...f, direction: v }))}
                      options={[
                        { value: "ALL", label: "All" },
                        { value: "LONG", label: "Long only" },
                        { value: "SHORT", label: "Short only" },
                      ]}
                    />
                    <Select
                      label="Outcome"
                      value={filters.outcome}
                      onChange={(v) => setFilters((f) => ({ ...f, outcome: v }))}
                      options={[
                        { value: "ALL", label: "All" },
                        { value: "WINS", label: "Winners only" },
                        { value: "LOSSES", label: "Losers only" },
                      ]}
                    />

                    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                      <div style={{ fontSize: 12, opacity: 0.8 }}>Date Start (UTC)</div>
                      <input type="date" value={filters.dateStartUtc} onChange={(e) => setFilters((f) => ({ ...f, dateStartUtc: e.target.value }))} style={inputStyle} />
                    </div>
                    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                      <div style={{ fontSize: 12, opacity: 0.8 }}>Date End (UTC)</div>
                      <input type="date" value={filters.dateEndUtc} onChange={(e) => setFilters((f) => ({ ...f, dateEndUtc: e.target.value }))} style={inputStyle} />
                    </div>

                    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                      <div style={{ fontSize: 12, opacity: 0.8 }}>Min PnL ($)</div>
                      <input type="text" value={filters.minPnl} onChange={(e) => setFilters((f) => ({ ...f, minPnl: e.target.value }))} placeholder="e.g. -50" style={inputStyle} />
                    </div>
                    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                      <div style={{ fontSize: 12, opacity: 0.8 }}>Max PnL ($)</div>
                      <input type="text" value={filters.maxPnl} onChange={(e) => setFilters((f) => ({ ...f, maxPnl: e.target.value }))} placeholder="e.g. 200" style={inputStyle} />
                    </div>

                    <div style={{ display: "flex", flexDirection: "column", gap: 6, gridColumn: "1 / -1" }}>
                      <div style={{ fontSize: 12, opacity: 0.8 }}>Tag Search</div>
                      <input type="text" value={filters.tagQuery} onChange={(e) => setFilters((f) => ({ ...f, tagQuery: e.target.value }))} placeholder="e.g. ADD_RETEST, TP_1R" style={inputStyle} />
                    </div>

                    <button type="button" onClick={() => setFilters((f) => ({ ...f, direction: "ALL", outcome: "ALL", tagQuery: "", minPnl: "", maxPnl: "" }))} style={secondaryBtnStyle}>
                      Reset Filters (keep dates)
                    </button>
                  </div>

                  {result ? (
                    <div style={{ marginTop: 12, fontSize: 12, opacity: 0.7, lineHeight: 1.5 }}>
                      Filtered Net: <b>{formatMoney(filteredStats.net)}</b> • Filtered WinRate: <b>{formatPct(filteredStats.winRate)}</b>
                    </div>
                  ) : null}
                </div>
              </div>
            </div>

          </div>
        </div>

      </div>
    </div>
  );
}

/* ===================== Styles ===================== */

const pageStyle: React.CSSProperties = {
  minHeight: "100vh",
  padding: 28,
  background:
    "radial-gradient(1100px 700px at 18% 10%, rgba(57,255,20,0.35), rgba(0,0,0,0) 62%), radial-gradient(1100px 700px at 82% 18%, rgba(0,255,170,0.22), rgba(0,0,0,0) 58%), linear-gradient(135deg, #050607 0%, #050b07 42%, #000000 100%)",
  color: "#EAFBEA",
  fontFamily: 'ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial',
};

const containerStyle: React.CSSProperties = { maxWidth: 1400, margin: "0 auto" };
const headerRowStyle: React.CSSProperties = { display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 16, flexWrap: "wrap" };
const h1Style: React.CSSProperties = { fontSize: 38, fontWeight: 900, letterSpacing: -0.8, margin: 0 };
const pillStyle: React.CSSProperties = { fontSize: 12, padding: "7px 12px", borderRadius: 999, border: "1px solid rgba(57,255,20,0.35)", background: "rgba(57,255,20,0.08)", color: "rgba(234,251,234,0.92)" };
const rightHintStyle: React.CSSProperties = { fontSize: 12, opacity: 0.7 };
const subheadStyle: React.CSSProperties = { marginTop: 12, opacity: 0.86, maxWidth: 1100, lineHeight: 1.6 };

const cardStyle: React.CSSProperties = { marginTop: 22, borderRadius: 20, border: "1px solid rgba(57,255,20,0.25)", background: "rgba(10, 14, 12, 0.72)", boxShadow: "0 22px 70px rgba(0,0,0,0.45)", overflow: "hidden" };
const cardTopGlowStyle: React.CSSProperties = { height: 2, background: "linear-gradient(90deg, rgba(57,255,20,0), rgba(57,255,20,0.75), rgba(57,255,20,0))" };
const cardInnerStyle: React.CSSProperties = { padding: 22 };

const topControlsGrid: React.CSSProperties = { display: "grid", gridTemplateColumns: "1.35fr 0.65fr", gap: 18, alignItems: "stretch" };
const uploadBlockStyle: React.CSSProperties = { borderRadius: 18, border: "1px solid rgba(57,255,20,0.16)", background: "rgba(0,0,0,0.20)", padding: 18 };
const runBlockStyle: React.CSSProperties = { borderRadius: 18, border: "1px solid rgba(57,255,20,0.16)", background: "rgba(0,0,0,0.20)", padding: 18, display: "flex", flexDirection: "column", justifyContent: "space-between" };

const labelTitleStyle: React.CSSProperties = { fontSize: 14, fontWeight: 900, letterSpacing: -0.2 };
const labelSubStyle: React.CSSProperties = { marginTop: 6, fontSize: 12, opacity: 0.75, lineHeight: 1.5 };

const uploadRowStyle: React.CSSProperties = { marginTop: 14, display: "grid", gridTemplateColumns: "auto 1fr", gap: 14, alignItems: "center" };
const fileBtnStyle: React.CSSProperties = { padding: "12px 16px", borderRadius: 14, border: "1px solid rgba(57,255,20,0.35)", background: "linear-gradient(135deg, rgba(57,255,20,0.22), rgba(0,255,170,0.10))", color: "#EAFBEA", fontWeight: 800, cursor: "pointer", boxShadow: "0 10px 26px rgba(0,0,0,0.35)", whiteSpace: "nowrap" };
const secondaryBtnStyle: React.CSSProperties = { padding: "10px 14px", borderRadius: 14, border: "1px solid rgba(57,255,20,0.22)", background: "rgba(0,0,0,0.25)", color: "#EAFBEA", fontWeight: 800, cursor: "pointer" };

const dividerStyle: React.CSSProperties = { height: 1, marginTop: 18, background: "rgba(57,255,20,0.18)" };

const contentGrid: React.CSSProperties = { marginTop: 18, display: "grid", gridTemplateColumns: "1.25fr 0.75fr", gap: 18, alignItems: "start" };

const panelStyle: React.CSSProperties = { borderRadius: 18, border: "1px solid rgba(57,255,20,0.16)", background: "rgba(0,0,0,0.20)", padding: 18 };

const kpiGrid: React.CSSProperties = { marginTop: 14, display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 12 };

const chartPanelStyle: React.CSSProperties = { marginTop: 14, borderRadius: 16, border: "1px solid rgba(57,255,20,0.16)", background: "rgba(0,0,0,0.20)", padding: 14 };

const fileMetaStyle: React.CSSProperties = { display: "flex", flexDirection: "column", gap: 4, minWidth: 0 };

const tableWrapStyle: React.CSSProperties = { marginTop: 12, overflow: "auto", maxHeight: 520, borderRadius: 14, border: "1px solid rgba(57,255,20,0.14)" };

const tableStyle: React.CSSProperties = { width: "100%", borderCollapse: "collapse", fontSize: 12 };
const tableHeaderRowStyle: React.CSSProperties = { position: "sticky", top: 0, background: "rgba(0,0,0,0.85)" };
const thStyle: React.CSSProperties = { textAlign: "left", padding: "10px 10px", borderBottom: "1px solid rgba(57,255,20,0.18)", fontWeight: 900, whiteSpace: "nowrap" };
const tdStyle: React.CSSProperties = { padding: "10px 10px" };
const tdStyleStrong: React.CSSProperties = { padding: "10px 10px", fontWeight: 900 };
const tdStyleMono: React.CSSProperties = { padding: "10px 10px", whiteSpace: "nowrap", opacity: 0.9 };

const inputStyle: React.CSSProperties = { width: "100%", padding: "10px 12px", borderRadius: 12, border: "1px solid rgba(57,255,20,0.18)", background: "rgba(0,0,0,0.35)", color: "rgba(234,251,234,0.95)", outline: "none" };

const footerStyle: React.CSSProperties = { marginTop: 16, fontSize: 12, opacity: 0.7 };

const codeStyle: React.CSSProperties = { padding: "2px 6px", borderRadius: 8, border: "1px solid rgba(57,255,20,0.22)", background: "rgba(57,255,20,0.08)", color: "rgba(234,251,234,0.95)" };

const infoIconStyle: React.CSSProperties = { width: 18, height: 18, borderRadius: 999, border: "1px solid rgba(57,255,20,0.25)", background: "rgba(0,0,0,0.35)", color: "rgba(234,251,234,0.85)", display: "inline-flex", alignItems: "center", justifyContent: "center", fontSize: 12, cursor: "help", outline: "none" };

const tooltipFixedStyle: React.CSSProperties = { position: "fixed", zIndex: 99999, width: "min(340px, 70vw)", padding: "10px 10px", borderRadius: 12, border: "1px solid rgba(57,255,20,0.22)", background: "rgba(0,0,0,0.92)", color: "rgba(234,251,234,0.92)", fontSize: 12, lineHeight: 1.4, boxShadow: "0 14px 40px rgba(0,0,0,0.55)" };

function runBtnStyle(disabled: boolean): React.CSSProperties {
  return {
    marginTop: 14,
    padding: "14px 16px",
    borderRadius: 14,
    border: "1px solid rgba(57,255,20,0.45)",
    background: disabled ? "rgba(255,255,255,0.06)" : "linear-gradient(135deg, rgba(57,255,20,0.35), rgba(0,255,170,0.18))",
    color: disabled ? "rgba(234,251,234,0.55)" : "#EAFBEA",
    fontWeight: 900,
    cursor: disabled ? "not-allowed" : "pointer",
    width: "100%",
  };
}
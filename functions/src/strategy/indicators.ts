// Ported from ~/Projects/money-maker/src/bxTrenderCalc.ts and macdexpCandleBacktest.ts.
// Matches TradingView's built-ins: ema() seeded with an SMA of the first `len` values then
// recursive (alpha = 2/(len+1)); rsi() uses Wilder's RMA (alpha = 1/len). Warm-up bars are NaN.

const isNum = (x: number) => Number.isFinite(x);

function expMA(src: number[], len: number, alpha: number): number[] {
  const out = new Array<number>(src.length).fill(NaN);
  let prev = NaN;
  let count = 0,
    sum = 0;
  for (let i = 0; i < src.length; i++) {
    const x = src[i];
    if (!isNum(x)) {
      count = 0;
      sum = 0;
      continue;
    }
    if (!isNum(prev)) {
      sum += x;
      count++;
      if (count > len) {
        sum -= src[i - len];
        count = len;
      }
      if (count === len) {
        prev = sum / len;
        out[i] = prev;
      }
    } else {
      prev = alpha * x + (1 - alpha) * prev;
      out[i] = prev;
    }
  }
  return out;
}

export const ema = (src: number[], len: number) => expMA(src, len, 2 / (len + 1));
const rma = (src: number[], len: number) => expMA(src, len, 1 / len);

export function rsi(src: number[], len: number): number[] {
  const up = src.map((x, i) => (i > 0 && isNum(x) && isNum(src[i - 1]) ? Math.max(x - src[i - 1], 0) : NaN));
  const dn = src.map((x, i) => (i > 0 && isNum(x) && isNum(src[i - 1]) ? Math.max(src[i - 1] - x, 0) : NaN));
  const au = rma(up, len),
    ad = rma(dn, len);
  return au.map((u, i) => {
    const d = ad[i];
    if (!isNum(u) || !isNum(d)) return NaN;
    if (d === 0) return 100;
    if (u === 0) return 0;
    return 100 - 100 / (1 + u / d);
  });
}

/** Simple moving average, NaN for the warm-up bars. */
export function sma(src: number[], len: number): number[] {
  return src.map((_, i) => {
    if (i < len - 1) return NaN;
    let sum = 0;
    for (let k = i - len + 1; k <= i; k++) {
      if (Number.isNaN(src[k])) return NaN;
      sum += src[k];
    }
    return sum / len;
  });
}

"""
Point-in-time technical-analysis features — a faithful port of the Node
backend's features.js so the sidecar models compete on identical inputs.

Every function only ever inspects data at-or-before the requested index, which is
what keeps the walk-forward backtest leak-free.
"""
from __future__ import annotations
import math


def log_returns(closes):
    out = []
    for i in range(1, len(closes)):
        a, b = closes[i - 1], closes[i]
        if a > 0 and b > 0:
            out.append(math.log(b / a))
    return out


def _mean(a):
    return sum(a) / len(a) if a else 0.0


def _stdev(a):
    if len(a) < 2:
        return 0.0
    m = _mean(a)
    return math.sqrt(sum((x - m) ** 2 for x in a) / (len(a) - 1))


def _sma(arr, n):
    if len(arr) < n:
        return None
    return sum(arr[-n:]) / n


def _rsi(prices, period=14):
    if len(prices) < period + 1:
        return None
    gains = losses = 0.0
    for i in range(len(prices) - period, len(prices)):
        diff = prices[i] - prices[i - 1]
        if diff >= 0:
            gains += diff
        else:
            losses -= diff
    if losses == 0:
        return 100.0
    rs = (gains / period) / (losses / period)
    return 100.0 - 100.0 / (1.0 + rs)


def daily_vol(closes, window=30):
    r = log_returns(closes[-(window + 1):])
    return _stdev(r) if len(r) >= 2 else 0.0


def feature_row(closes, j):
    """8-feature vector for index j (uses closes[0..j] only), or None."""
    if j < 50:
        return None
    win = closes[max(0, j - 59): j + 1]   # ≤50-day lookback; matches features.js
    price = win[-1]
    if not price > 0:
        return None
    r = log_returns(win)
    ret1 = r[-1] if r else 0.0
    ret5 = _mean(r[-5:]) if len(r) >= 5 else 0.0
    ret10 = _mean(r[-10:]) if len(r) >= 10 else 0.0
    s10, s20, s50 = _sma(win, 10), _sma(win, 20), _sma(win, 50)
    rsi14 = _rsi(win, 14)
    vol30 = daily_vol(win, 30)
    if s10 is None or s20 is None or s50 is None or rsi14 is None:
        return None
    return [
        ret1, ret5, ret10,
        s10 / price - 1, s20 / price - 1, s50 / price - 1,
        rsi14 / 100 - 0.5, vol30,
    ]


FEATURE_NAMES = ['ret1', 'ret5', 'ret10', 'sma10_gap', 'sma20_gap', 'sma50_gap', 'rsi14_c', 'vol30']

/**
 * Tiny linear-algebra helpers for the in-process regression models (AR least
 * squares, ridge). Dimensions here are small (≤ ~10), so a plain Gaussian
 * elimination with partial pivoting is more than adequate.
 */

/** Solve the square system A x = b. Returns x, or null if A is singular. */
export function solve(A, b) {
  const n = A.length;
  // Augmented matrix (deep copy so callers' data is untouched).
  const M = A.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    // Partial pivot: largest magnitude in this column.
    let piv = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
    }
    if (Math.abs(M[piv][col]) < 1e-12) return null; // singular
    [M[col], M[piv]] = [M[piv], M[col]];
    // Eliminate below.
    for (let r = col + 1; r < n; r++) {
      const f = M[r][col] / M[col][col];
      for (let c = col; c <= n; c++) M[r][c] -= f * M[col][c];
    }
  }
  // Back-substitution.
  const x = new Array(n).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    let s = M[i][n];
    for (let j = i + 1; j < n; j++) s -= M[i][j] * x[j];
    x[i] = s / M[i][i];
  }
  return x;
}

/**
 * Ridge regression: minimize ||Xb - y||^2 + lambda * ||b||^2 (intercept NOT
 * penalized — it's handled by the caller via a leading 1 column with lambda 0 on
 * that diagonal entry). Returns the coefficient vector or null.
 *
 * X: rows of features (each already includes any intercept column).
 * penalize: boolean[] same length as a feature row — whether to apply lambda to
 *   that coefficient (false for the intercept).
 */
export function ridgeSolve(X, y, lambda, penalize) {
  const p = X[0].length;
  // Normal equations: (X'X + lambda*P) b = X'y
  const XtX = Array.from({ length: p }, () => new Array(p).fill(0));
  const Xty = new Array(p).fill(0);
  for (let r = 0; r < X.length; r++) {
    const row = X[r];
    for (let i = 0; i < p; i++) {
      Xty[i] += row[i] * y[r];
      for (let j = 0; j < p; j++) XtX[i][j] += row[i] * row[j];
    }
  }
  for (let i = 0; i < p; i++) {
    if (!penalize || penalize[i]) XtX[i][i] += lambda;
  }
  return solve(XtX, Xty);
}

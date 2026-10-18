// Runs the Monte Carlo off the main thread, so the page stays responsive at 100,000 paths.
import { simulate } from './simulate.js';

self.onmessage = (e) => {
  const { id, params } = e.data;
  try {
    self.postMessage({ id, result: simulate(params) });
  } catch (err) {
    self.postMessage({ id, error: err.message || String(err) });
  }
};

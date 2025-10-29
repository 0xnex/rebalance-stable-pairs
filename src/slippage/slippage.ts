import slippageConfig from "./config.json";

interface SlippageConfigItem {
  amountThreshold: number;
  maxSlippage: number;
}

interface TokenPairConfig {
  tokenA: string;
  tokenB: string;
  configs: SlippageConfigItem[];
}

type SlippageConfig = Record<string, TokenPairConfig[]>;

/**
 * Get max slippage with random value based on swap amount and token pair
 * @param tokenA - First token symbol
 * @param tokenB - Second token symbol
 * @param swapAmount - Amount to swap
 * @returns Random slippage value or null if amount exceeds max threshold
 */
export function getMaxSlippage(
  tokenA: string,
  tokenB: string,
  swapAmount: number
): number | null {
  const config = slippageConfig as SlippageConfig;

  // Try both possible pair keys
  let pairKey = `${tokenA}-${tokenB}`;
  let pairConfigs = config[pairKey];

  // If not found, try reverse order
  if (!pairConfigs) {
    pairKey = `${tokenB}-${tokenA}`;
    pairConfigs = config[pairKey];
  }

  if (!pairConfigs) {
    throw new Error(
      `No config found for token pair: ${tokenA}-${tokenB} or ${tokenB}-${tokenA}`
    );
  }

  // Find the matching direction (tokenA->tokenB)
  const directionConfig = pairConfigs.find(
    (pair) => pair.tokenA === tokenA && pair.tokenB === tokenB
  );

  if (!directionConfig) {
    throw new Error(`No config found for direction: ${tokenA} -> ${tokenB}`);
  }

  const { configs } = directionConfig;

  // Sort configs by amountThreshold ascending
  const sortedConfigs = [...configs].sort(
    (a, b) => a.amountThreshold - b.amountThreshold
  );

  // Find the appropriate threshold range
  for (let i = 0; i < sortedConfigs.length; i++) {
    const current = sortedConfigs[i];
    const next = sortedConfigs[i + 1];

    if (!current) continue;

    // Case 1: swapAmount <= first threshold
    // Range: [0, first.maxSlippage]
    if (i === 0 && swapAmount <= current.amountThreshold) {
      return randomInRange(0, current.maxSlippage);
    }

    // Case 2: swapAmount is between current and next threshold
    // Range: [current.maxSlippage, next.maxSlippage]
    if (
      swapAmount > current.amountThreshold &&
      next &&
      swapAmount <= next.amountThreshold
    ) {
      return randomInRange(current.maxSlippage, next.maxSlippage);
    }
  }

  // Case 3: swapAmount exceeds the last threshold
  // Return null
  return null;
}

/**
 * Generate random number in range [min, max]
 * @param min - Minimum value
 * @param max - Maximum value
 * @returns Random number between min and max
 */
function randomInRange(min: number, max: number): number {
  return Math.random() * (max - min) + min;
}
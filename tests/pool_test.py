import unittest
from src.pool import Pool, Q64, Base

class TestPool(unittest.TestCase):
    def setUp(self):
        self.pool = Pool(100, 60)
        self.pool.sqrtPriceX64 = self.pool.tickToSqrtPrice(7)
        self.pool.liquidity = 1000000
        self.pool.tickCurrent = 7

    def test_price(self):
        self.assertAlmostEqual(self.pool.price, Base ** 7, places=6)

    def test_tickToSqrtPrice_and_sqrtPriceToTick(self):
        tick = 7
        sqrt_price = self.pool.tickToSqrtPrice(tick)
        self.assertEqual(self.pool.sqrtPriceToTick(sqrt_price), tick)

    def test_applyLiquidityDelta(self):
        self.pool.applyLiquidityDelta(5, 10, 1000)
        self.assertTrue(self.pool.liquidity > 0)

    def test_calculateFees(self):
        fees = self.pool.calculateFees(10000)
        self.assertTrue(fees["totalFee"] > 0)
        self.assertTrue(fees["lpFee"] > 0)
        self.assertTrue(fees["protocolFee"] >= 0)

    def test_serialize_deserialize(self):
        s = self.pool.serialize()
        pool2 = Pool.deserialize(s)
        self.assertEqual(pool2.liquidity, self.pool.liquidity)
        self.assertEqual(pool2.tickCurrent, self.pool.tickCurrent)

    def test_mulDivRoundingDown(self):
        self.assertEqual(self.pool.mulDivRoundingDown(10, 5, 2), 25)

    def test_estimateAmountOut(self):
        result = self.pool.estimateAmountOut(10000, True)
        self.assertIn("amountOut", result)
        self.assertIn("feeAmount", result)
        self.assertIn("priceImpact", result)

    def test_estimateAmountIn(self):
        result = self.pool.estimateAmountIn(5000, True)
        self.assertIn("amountIn", result)
        self.assertIn("feeAmount", result)
        self.assertIn("totalCost", result)
        self.assertIn("priceImpact", result)

    def test_estimateSwapCost(self):
        result = self.pool.estimateSwapCost(10000, True)
        self.assertIn("amountOut", result)
        self.assertIn("feeAmount", result)
        self.assertIn("priceImpact", result)
        self.assertIn("effectivePrice", result)
        self.assertIn("slippage", result)
        self.assertIn("totalCost", result)

if __name__ == "__main__":
    unittest.main()

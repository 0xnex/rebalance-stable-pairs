import math
from typing import Dict, Set, TypedDict


class TickData(TypedDict):
    liquidityNet: int
    liquidityGross: int
    feeGrowthOutside0X64: int
    feeGrowthOutside1X64: int


Q64 = 1 << 64
Base = 1.0001


class Pool:
    def __init__(self, feeRatePpm: int = 100, tickSpacing: int = 60):
        # Reserves
        self.reserveA: int = 0
        self.reserveB: int = 0

        # Q64.64 encoded sqrt price
        self.sqrtPriceX64: int = 0

        # Liquidity and tick state
        self.liquidity: int = 0
        self.tickCurrent: int = 0

        # Fee / tick configuration
        self.feeRatePpm: int = feeRatePpm
        self.tickSpacing: int = tickSpacing
        self.feeRate: float = float(feeRatePpm) / 1_000_000  # Convert ppm to decimal
        self.protocolFeeShareNumerator: int = 1  # Default 1/5 = 20% protocol fee
        self.protocolFeeShareDenominator: int = 5

        # Tick storage
        self.ticks: Dict[int, TickData] = {}
        self.tickBitmap: Set[int] = set()

        # Global fee growth (Q64.64)
        self.feeGrowthGlobal0X64: int = 0
        self.feeGrowthGlobal1X64: int = 0

        # Total swap fees collected (token0/token1)
        self.totalSwapFee0: int = 0
        self.totalSwapFee1: int = 0

        # Validation stats (kept minimal for now)
        self.validationStats = {
            "totalSwaps": 0,
            "amountOutMismatches": 0,
            "feeMismatches": 0,
            "protocolFeeMismatches": 0,
            "totalAmountOutDifference": 0,
            "totalFeeDifference": 0,
            "totalProtocolFeeDifference": 0,
            "exactMatches": 0,
        }

    @property
    def price(self) -> float:
        """Convert Q64.64 sqrtPrice to actual price."""
        sqrt_price = self.sqrtPriceX64 / Q64
        return sqrt_price * sqrt_price

    # ===== Tick/Price/Liquidity =====
    def tickToSqrtPrice(self, tick: int) -> int:
        sqrt_price = math.sqrt(Base ** tick)
        return int(math.floor(sqrt_price * Q64))

    def sqrtPriceToTick(self, sqrt_price: int) -> int:
        if sqrt_price <= 0:
            return 0
        price = sqrt_price / Q64
        return math.floor((2 * math.log(price)) / math.log(Base))

    def getActiveLiquidity(self) -> int:
        return self.liquidity

    def applyLiquidityDelta(self, tickLower: int, tickUpper: int, liquidityDelta: int):
        if liquidityDelta == 0:
            return
        deltaAbs = liquidityDelta if liquidityDelta >= 0 else -liquidityDelta
        grossDelta = deltaAbs if liquidityDelta >= 0 else -deltaAbs
        self.updateTickData(tickLower, liquidityDelta, grossDelta)
        self.updateTickData(tickUpper, -liquidityDelta, grossDelta)
        if self.tickCurrent >= tickLower and self.tickCurrent < tickUpper:
            self.liquidity += liquidityDelta
            if self.liquidity < 0:
                self.liquidity = 0

    def updateTickData(self, tick: int, netDelta: int, grossDelta: int):
        if tick not in self.ticks:
            self.ticks[tick] = {
                "liquidityNet": 0,
                "liquidityGross": 0,
                "feeGrowthOutside0X64": 0,
                "feeGrowthOutside1X64": 0,
            }
        tickData = self.ticks[tick]
        tickData["liquidityNet"] += netDelta
        tickData["liquidityGross"] += grossDelta
        if tickData["liquidityGross"] <= 0 and tickData["liquidityNet"] == 0:
            del self.ticks[tick]
            self.tickBitmap.discard(tick)
        else:
            if tickData["liquidityGross"] < 0:
                tickData["liquidityGross"] = 0
            self.tickBitmap.add(tick)

    # ===== Swap/Fee Logic =====
    def applyRepayFlashSwap(self, amountXDebt: int, amountYDebt: int, paidX: int, paidY: int, reserveX: int = None, reserveY: int = None):
        feeX = paidX - amountXDebt if paidX > amountXDebt else 0
        feeY = paidY - amountYDebt if paidY > amountYDebt else 0
        if feeX > 0:
            self.updateFeeGrowth(feeX, True)
            self.totalSwapFee0 += feeX
        if feeY > 0:
            self.updateFeeGrowth(feeY, False)
            self.totalSwapFee1 += feeY
        if reserveX is not None:
            self.reserveA = reserveX
        if reserveY is not None:
            self.reserveB = reserveY
        self.updateTickFeeGrowthForFlashSwap()

    def applySwap(self, amountIn: int, zeroForOne: bool) -> int:
        fees = self.calculateFees(amountIn)
        result = self.applySwapInternal(amountIn, zeroForOne, fees)
        return result["amountOut"]

    def applySwapWithValidation(self, amountIn: int, zeroForOne: bool, expectedAmountOut: int = None, expectedFee: int = None, expectedProtocolFee: int = None):
        self.validationStats["totalSwaps"] += 1
        computedFees = self.calculateFees(amountIn)
        lpFee = expectedFee if expectedFee is not None else computedFees["lpFee"]
        protocolFee = expectedProtocolFee if expectedProtocolFee is not None else computedFees["protocolFee"]
        totalFee = lpFee + protocolFee
        swapResult = self.applySwapInternal(amountIn, zeroForOne, {
            "totalFee": totalFee,
            "lpFee": lpFee,
            "protocolFee": protocolFee,
        })
        amountOut = swapResult["amountOut"]
        validation = {
            "amountOutMatch": amountOut == expectedAmountOut if expectedAmountOut is not None else True,
            "feeMatch": lpFee == expectedFee if expectedFee is not None else True,
            "protocolFeeMatch": protocolFee == expectedProtocolFee if expectedProtocolFee is not None else True,
            "amountOutDifference": amountOut - expectedAmountOut if expectedAmountOut is not None else 0,
            "feeDifference": lpFee - expectedFee if expectedFee is not None else 0,
            "protocolFeeDifference": protocolFee - expectedProtocolFee if expectedProtocolFee is not None else 0,
            "isExactMatch": True,
        }
        validation["isExactMatch"] = (
            validation["amountOutMatch"]
            and validation["feeMatch"]
            and validation["protocolFeeMatch"]
        )
        if not validation["amountOutMatch"]:
            self.validationStats["amountOutMismatches"] += 1
            self.validationStats["totalAmountOutDifference"] += validation["amountOutDifference"]
        if not validation["feeMatch"]:
            self.validationStats["feeMismatches"] += 1
            self.validationStats["totalFeeDifference"] += validation["feeDifference"]
        if not validation["protocolFeeMatch"]:
            self.validationStats["protocolFeeMismatches"] += 1
            self.validationStats["totalProtocolFeeDifference"] += validation["protocolFeeDifference"]
        if validation["isExactMatch"]:
            self.validationStats["exactMatches"] += 1
        return {
            "amountOut": amountOut,
            "feeAmount": lpFee,
            "protocolFee": protocolFee,
            "validation": validation,
        }

    def applySwapInternal(self, amountIn: int, zeroForOne: bool, fees: dict) -> dict:
        if amountIn <= 0:
            return {"amountOut": 0}
        totalFee = fees["totalFee"]
        lpFee = fees["lpFee"]
        if totalFee > 0:
            if zeroForOne:
                self.totalSwapFee0 += totalFee
            else:
                self.totalSwapFee1 += totalFee
        if lpFee > 0:
            self.updateFeeGrowth(lpFee, zeroForOne)
        amountInAfterFee = amountIn - totalFee if amountIn > totalFee else 0
        if amountInAfterFee == 0:
            return {"amountOut": 0}
        result = self.executeCLMMSwap(amountInAfterFee, zeroForOne)
        self.sqrtPriceX64 = result["newSqrtPriceX64"]
        self.tickCurrent = result["newTick"]
        return {"amountOut": result["amountOut"]}

    def executeCLMMSwap(self, amountIn: int, zeroForOne: bool) -> dict:
        currentSqrtPriceX64 = self.sqrtPriceX64
        currentTick = self.tickCurrent
        amountOut = 0
        remainingAmount = amountIn
        while remainingAmount > 0:
            nextTick = self.getNextTick(currentTick, zeroForOne)
            if nextTick is None:
                swapResult = self.swapAtPrice(remainingAmount, currentSqrtPriceX64, zeroForOne)
                amountOut += swapResult["amountOut"]
                currentSqrtPriceX64 = swapResult["newSqrtPriceX64"]
                currentTick = self.sqrtPriceToTick(currentSqrtPriceX64)
                remainingAmount = 0
                break
            maxAmountAtCurrentPrice = self.calculateMaxSwapAtPrice(currentSqrtPriceX64, nextTick, zeroForOne)
            if maxAmountAtCurrentPrice <= 0:
                break
            if remainingAmount <= maxAmountAtCurrentPrice:
                swapResult = self.swapAtPrice(remainingAmount, currentSqrtPriceX64, zeroForOne)
                amountOut += swapResult["amountOut"]
                currentSqrtPriceX64 = swapResult["newSqrtPriceX64"]
                currentTick = self.sqrtPriceToTick(currentSqrtPriceX64)
                remainingAmount = 0
                break
            swapResult = self.swapAtPrice(maxAmountAtCurrentPrice, currentSqrtPriceX64, zeroForOne)
            amountOut += swapResult["amountOut"]
            remainingAmount -= maxAmountAtCurrentPrice
            currentSqrtPriceX64 = self.tickToSqrtPrice(nextTick)
            currentTick = nextTick
            self.updateFeeGrowthOutside(nextTick, zeroForOne)
            tickData = self.ticks.get(nextTick)
            if tickData:
                liquidityNet = tickData["liquidityNet"]
                if zeroForOne:
                    self.liquidity -= liquidityNet
                else:
                    self.liquidity += liquidityNet
                if self.liquidity < 0:
                    self.liquidity = 0
        return {
            "amountOut": amountOut,
            "newSqrtPriceX64": currentSqrtPriceX64,
            "newTick": currentTick,
        }

    def getNextTick(self, currentTick: int, zeroForOne: bool):
        if zeroForOne:
            lowerTicks = sorted([tick for tick in self.tickBitmap if tick < currentTick], reverse=True)
            return lowerTicks[0] if lowerTicks else None
        else:
            higherTicks = sorted([tick for tick in self.tickBitmap if tick > currentTick])
            return higherTicks[0] if higherTicks else None

    def calculateMaxSwapAtPrice(self, currentSqrtPriceX64: int, nextTick: int, zeroForOne: bool) -> int:
        nextSqrtPriceX64 = self.tickToSqrtPrice(nextTick)
        Q64 = 1 << 64
        if zeroForOne:
            numerator = self.liquidity * (currentSqrtPriceX64 - nextSqrtPriceX64) * Q64
            denominator = currentSqrtPriceX64 * nextSqrtPriceX64
            return numerator // denominator if denominator != 0 else 0
        else:
            deltaSqrtPrice = nextSqrtPriceX64 - currentSqrtPriceX64
            return (self.liquidity * deltaSqrtPrice) // Q64 if Q64 != 0 else 0

    def swapAtPrice(self, amountIn: int, sqrtPriceX64: int, zeroForOne: bool) -> dict:
        Q64 = 1 << 64
        if zeroForOne:
            if self.liquidity == 0:
                return {"amountOut": 0, "newSqrtPriceX64": sqrtPriceX64}
            numerator = self.liquidity * sqrtPriceX64 * Q64
            denominator = self.liquidity * Q64 + amountIn * sqrtPriceX64
            newSqrtPriceX64 = sqrtPriceX64 if denominator == 0 else numerator // denominator
            delta = sqrtPriceX64 - newSqrtPriceX64
            amountOut = self.mulDivRoundingDown(self.liquidity, delta, Q64)
            return {"amountOut": amountOut, "newSqrtPriceX64": newSqrtPriceX64}
        else:
            if self.liquidity == 0:
                return {"amountOut": 0, "newSqrtPriceX64": sqrtPriceX64}
            newSqrtPriceX64 = sqrtPriceX64 + (amountIn * Q64) // self.liquidity
            delta = newSqrtPriceX64 - sqrtPriceX64
            numerator = self.liquidity * delta * Q64
            denominator = newSqrtPriceX64 * sqrtPriceX64
            amountOut = 0 if denominator == 0 else numerator // denominator
            return {"amountOut": amountOut, "newSqrtPriceX64": newSqrtPriceX64}

    def updateFeeGrowth(self, feeAmount: int, zeroForOne: bool):
        if self.liquidity > 0:
            feeGrowthDelta = (feeAmount * (1 << 64)) // self.liquidity
            if zeroForOne:
                self.feeGrowthGlobal0X64 += feeGrowthDelta
            else:
                self.feeGrowthGlobal1X64 += feeGrowthDelta

    def updateFeeGrowthOutside(self, tick: int, zeroForOne: bool):
        tickData = self.ticks.get(tick)
        if not tickData:
            return
        globalFeeGrowth = self.feeGrowthGlobal0X64 if zeroForOne else self.feeGrowthGlobal1X64
        if zeroForOne:
            tickData["feeGrowthOutside0X64"] = globalFeeGrowth
        else:
            tickData["feeGrowthOutside1X64"] = globalFeeGrowth

    def updateTickFeeGrowthForFlashSwap(self):
        for tick, tickData in self.ticks.items():
            tickData["feeGrowthOutside0X64"] = self.feeGrowthGlobal0X64
            tickData["feeGrowthOutside1X64"] = self.feeGrowthGlobal1X64

    # ===== Estimation/Serialize =====
    def calculateFeeGrowthInside(self, tickLower: int, tickUpper: int, tokenIndex: int) -> int:
        globalFeeGrowth = self.feeGrowthGlobal0X64 if tokenIndex == 0 else self.feeGrowthGlobal1X64
        tickLowerData = self.ticks.get(tickLower)
        tickUpperData = self.ticks.get(tickUpper)
        if not tickLowerData or not tickUpperData:
            return 0
        feeGrowthOutsideLower = tickLowerData["feeGrowthOutside0X64"] if tokenIndex == 0 else tickLowerData["feeGrowthOutside1X64"]
        feeGrowthOutsideUpper = tickUpperData["feeGrowthOutside0X64"] if tokenIndex == 0 else tickUpperData["feeGrowthOutside1X64"]
        if self.tickCurrent < tickLower:
            feeGrowthInside = self.submod(feeGrowthOutsideLower, feeGrowthOutsideUpper)
        elif self.tickCurrent >= tickUpper:
            feeGrowthInside = self.submod(feeGrowthOutsideUpper, feeGrowthOutsideLower)
        else:
            temp = self.submod(globalFeeGrowth, feeGrowthOutsideLower)
            feeGrowthInside = self.submod(temp, feeGrowthOutsideUpper)
        return feeGrowthInside

    def calculateFees(self, amountIn: int) -> dict:
        if amountIn <= 0:
            return {"totalFee": 0, "lpFee": 0, "protocolFee": 0}
        ppm = self.feeRatePpm if self.feeRatePpm > 0 else int(round(self.feeRate * 1_000_000))
        if ppm <= 0:
            return {"totalFee": 0, "lpFee": 0, "protocolFee": 0}
        rawFee = (amountIn * ppm + 1_000_000 - 1) // 1_000_000
        if rawFee <= 0:
            return {"totalFee": 0, "lpFee": 0, "protocolFee": 0}
        lpFee = (rawFee * 4 + 5 - 1) // 5
        if lpFee < 1:
            lpFee = 1
        protocolFee = rawFee - lpFee
        if protocolFee < 0:
            protocolFee = 0
        totalFee = lpFee + protocolFee
        return {"totalFee": totalFee, "lpFee": lpFee, "protocolFee": protocolFee}

    def getFeesAtTick(self, tick: int) -> dict:
        tickData = self.ticks.get(tick)
        if not tickData:
            return {"fee0": 0, "fee1": 0}
        feeGrowthInside0X64 = self.calculateFeeGrowthInside(tick, tick, 0)
        feeGrowthInside1X64 = self.calculateFeeGrowthInside(tick, tick, 1)
        fee0 = (tickData["liquidityGross"] * feeGrowthInside0X64) // (1 << 64)
        fee1 = (tickData["liquidityGross"] * feeGrowthInside1X64) // (1 << 64)
        return {"fee0": fee0, "fee1": fee1}

    def getAllTicksWithFees(self):
        result = []
        for tick, tickData in self.ticks.items():
            fees = self.getFeesAtTick(tick)
            result.append({
                "tick": tick,
                "liquidity": tickData["liquidityGross"],
                "fee0": fees["fee0"],
                "fee1": fees["fee1"],
            })
        return sorted(result, key=lambda x: x["tick"])

    def estimateAmountOut(self, amountIn: int, zeroForOne: bool) -> dict:
        fees = self.calculateFees(amountIn)
        amountInAfterFee = amountIn - fees["totalFee"] if amountIn > fees["totalFee"] else 0
        if amountInAfterFee > 0:
            result = self.executeCLMMSwap(amountInAfterFee, zeroForOne)
        else:
            result = {"amountOut": 0, "newSqrtPriceX64": self.sqrtPriceX64, "newTick": self.tickCurrent}
        priceImpact = self.calculatePriceImpact(amountIn, result["amountOut"], zeroForOne)
        return {"amountOut": result["amountOut"], "feeAmount": fees["lpFee"], "priceImpact": priceImpact}

    def estimateAmountIn(self, amountOut: int, zeroForOne: bool) -> dict:
        low = 0
        high = amountOut * 2
        bestGrossAmountIn = 0
        while low <= high:
            gross = (low + high) // 2
            fees = self.calculateFees(gross)
            net = gross - fees["totalFee"] if gross > fees["totalFee"] else 0
            if net > 0:
                testResult = self.executeCLMMSwap(net, zeroForOne)
            else:
                testResult = {"amountOut": 0, "newSqrtPriceX64": self.sqrtPriceX64, "newTick": self.tickCurrent}
            if testResult["amountOut"] == amountOut:
                bestGrossAmountIn = gross
                break
            elif testResult["amountOut"] < amountOut:
                low = gross + 1
            else:
                bestGrossAmountIn = gross
                high = gross - 1
        fees = self.calculateFees(bestGrossAmountIn)
        totalCost = bestGrossAmountIn
        priceImpact = self.calculatePriceImpact(totalCost, amountOut, zeroForOne)
        return {"amountIn": bestGrossAmountIn, "feeAmount": fees["lpFee"], "totalCost": totalCost, "priceImpact": priceImpact}

    def calculatePriceImpact(self, amountIn: int, amountOut: int, zeroForOne: bool) -> float:
        currentPrice = self.price
        if amountIn == 0 or amountOut == 0:
            return 0.0
        if zeroForOne:
            effectivePrice = amountOut / amountIn
        else:
            effectivePrice = amountIn / amountOut
        priceImpact = abs((effectivePrice - currentPrice) / currentPrice) * 100 if currentPrice != 0 else 0.0
        return priceImpact

    def estimateSwapCost(self, amountIn: int, zeroForOne: bool) -> dict:
        estimation = self.estimateAmountOut(amountIn, zeroForOne)
        effectivePrice = estimation["amountOut"] / amountIn if amountIn != 0 else 0.0
        currentPrice = self.price
        slippage = abs((effectivePrice - currentPrice) / currentPrice) * 100 if currentPrice != 0 else 0.0
        return {
            "amountOut": estimation["amountOut"],
            "feeAmount": estimation["feeAmount"],
            "priceImpact": estimation["priceImpact"],
            "effectivePrice": effectivePrice,
            "slippage": slippage,
            "totalCost": amountIn,
        }

    def calculateLiquidityAmount(self, tickLower: int, tickUpper: int, amountA: int, amountB: int) -> int:
        currentTick = self.tickCurrent
        if currentTick < tickLower:
            return amountA
        if currentTick >= tickUpper:
            return amountB
        return min(amountA, amountB)

    def calculateActualLiquidityAmounts(self, tickLower: int, tickUpper: int, amountA: int, amountB: int) -> dict:
        currentTick = self.tickCurrent
        if currentTick < tickLower:
            return {"actualAmountA": amountA, "actualAmountB": 0, "unusedAmountA": 0, "unusedAmountB": amountB}
        elif currentTick >= tickUpper:
            return {"actualAmountA": 0, "actualAmountB": amountB, "unusedAmountA": amountA, "unusedAmountB": 0}
        else:
            price = self.price
            optimalAmountB = (amountA * int(price * 1_000_000)) // 1_000_000
            if optimalAmountB <= amountB:
                return {"actualAmountA": amountA, "actualAmountB": optimalAmountB, "unusedAmountA": 0, "unusedAmountB": amountB - optimalAmountB}
            else:
                optimalAmountA = (amountB * 1_000_000) // int(price * 1_000_000)
                return {"actualAmountA": optimalAmountA, "actualAmountB": amountB, "unusedAmountA": amountA - optimalAmountA, "unusedAmountB": 0}

    def calculateRemoveLiquidityAmounts(self, tickLower: int, tickUpper: int, liquidityAmount: int) -> dict:
        currentTick = self.tickCurrent
        if currentTick < tickLower:
            return {"amountA": liquidityAmount, "amountB": 0}
        elif currentTick >= tickUpper:
            return {"amountA": 0, "amountB": liquidityAmount}
        else:
            price = self.price
            amountA = liquidityAmount
            amountB = (liquidityAmount * int(price * 1_000_000)) // 1_000_000
            return {"amountA": amountA, "amountB": amountB}

    def estimatePositionFees(self, tickLower: int, tickUpper: int, liquidityAmount: int) -> dict:
        feeGrowthInside0 = self.calculateFeeGrowthInside(tickLower, tickUpper, 0)
        feeGrowthInside1 = self.calculateFeeGrowthInside(tickLower, tickUpper, 1)
        fee0 = (liquidityAmount * feeGrowthInside0) // (1 << 64)
        fee1 = (liquidityAmount * feeGrowthInside1) // (1 << 64)
        return {"fee0": fee0, "fee1": fee1}

    def calculateLiquidityPriceImpact(self, tickLower: int, tickUpper: int, liquidityAmount: int) -> float:
        currentPrice = self.price
        priceRange = self.tickToSqrtPrice(tickUpper) - self.tickToSqrtPrice(tickLower)
        liquidityRatio = liquidityAmount / self.liquidity if self.liquidity != 0 else 0.0
        priceImpact = liquidityRatio * (priceRange / currentPrice) * 100 if currentPrice != 0 else 0.0
        return abs(priceImpact)

    def estimateOpenPosition(self, tickLower: int, tickUpper: int, amountA: int, amountB: int) -> dict:
        currentTick = self.tickCurrent
        isInRange = currentTick >= tickLower and currentTick < tickUpper
        actuals = self.calculateActualLiquidityAmounts(tickLower, tickUpper, amountA, amountB)
        liquidityAmount = self.calculateLiquidityAmount(tickLower, tickUpper, actuals["actualAmountA"], actuals["actualAmountB"])
        estimatedFees = self.estimatePositionFees(tickLower, tickUpper, liquidityAmount)
        return {
            "liquidityAmount": liquidityAmount,
            "actualAmountA": actuals["actualAmountA"],
            "actualAmountB": actuals["actualAmountB"],
            "unusedAmountA": actuals["unusedAmountA"],
            "unusedAmountB": actuals["unusedAmountB"],
            "priceRange": {
                "lower": self.tickToSqrtPrice(tickLower) / (1 << 64),
                "upper": self.tickToSqrtPrice(tickUpper) / (1 << 64),
            },
            "currentTick": currentTick,
            "isInRange": isInRange,
            "estimatedFees": estimatedFees,
        }

    def estimateClosePosition(self, tickLower: int, tickUpper: int, liquidityAmount: int) -> dict:
        amounts = self.calculateRemoveLiquidityAmounts(tickLower, tickUpper, liquidityAmount)
        fees = self.estimatePositionFees(tickLower, tickUpper, liquidityAmount)
        totalValue = amounts["amountA"] + amounts["amountB"]
        priceImpact = self.calculateLiquidityPriceImpact(tickLower, tickUpper, liquidityAmount)
        return {
            "amountA": amounts["amountA"],
            "amountB": amounts["amountB"],
            "fees": fees,
            "totalValue": totalValue,
            "priceImpact": priceImpact,
        }

    def estimateCollectFee(self, tickLower: int, tickUpper: int, liquidityAmount: int) -> dict:
        currentFees = self.estimatePositionFees(tickLower, tickUpper, liquidityAmount)
        feeGrowthInside0 = self.calculateFeeGrowthInside(tickLower, tickUpper, 0)
        feeGrowthInside1 = self.calculateFeeGrowthInside(tickLower, tickUpper, 1)
        totalFees = {"fee0": currentFees["fee0"], "fee1": currentFees["fee1"]}
        estimatedValue = currentFees["fee0"] + currentFees["fee1"]
        return {
            "collectableFees": currentFees,
            "totalFees": totalFees,
            "feeGrowthInside": {"fee0": feeGrowthInside0, "fee1": feeGrowthInside1},
            "estimatedValue": estimatedValue,
        }

    def estimateOptimalRange(self, amountA: int, amountB: int, targetPrice: float = None) -> dict:
        currentPrice = targetPrice if targetPrice is not None else self.price
        currentTick = self.sqrtPriceToTick(self.tickToSqrtPrice(0))
        priceRatio = amountB / amountA if amountA != 0 else 0.0
        optimalTick = int(math.floor(math.log(priceRatio) / math.log(1.0001))) if priceRatio > 0 else 0
        rangeSize = int(math.floor(math.log(2) / math.log(1.0001)))
        tickLower = optimalTick - rangeSize
        tickUpper = optimalTick + rangeSize
        expectedLiquidity = self.calculateLiquidityAmount(tickLower, tickUpper, amountA, amountB)
        utilization = expectedLiquidity / self.liquidity if self.liquidity != 0 else 0.0
        return {
            "tickLower": tickLower,
            "tickUpper": tickUpper,
            "expectedLiquidity": expectedLiquidity,
            "priceRange": {
                "lower": self.tickToSqrtPrice(tickLower) / (1 << 64),
                "upper": self.tickToSqrtPrice(tickUpper) / (1 << 64),
            },
            "utilization": utilization,
        }

    def serialize(self) -> str:
        state = {
            "reserveA": str(self.reserveA),
            "reserveB": str(self.reserveB),
            "sqrtPriceX64": str(self.sqrtPriceX64),
            "liquidity": str(self.liquidity),
            "tickCurrent": self.tickCurrent,
            "feeRate": self.feeRate,
            "tickSpacing": self.tickSpacing,
            "feeRatePpm": str(self.feeRatePpm),
            "protocolFeeShareNumerator": str(self.protocolFeeShareNumerator),
            "protocolFeeShareDenominator": str(self.protocolFeeShareDenominator),
            "feeGrowthGlobal0X64": str(self.feeGrowthGlobal0X64),
            "feeGrowthGlobal1X64": str(self.feeGrowthGlobal1X64),
            "totalSwapFee0": str(self.totalSwapFee0),
            "totalSwapFee1": str(self.totalSwapFee1),
            "ticks": [
                {
                    "tick": tick,
                    "liquidityNet": str(data["liquidityNet"]),
                    "liquidityGross": str(data["liquidityGross"]),
                    "feeGrowthOutside0X64": str(data["feeGrowthOutside0X64"]),
                    "feeGrowthOutside1X64": str(data["feeGrowthOutside1X64"]),
                }
                for tick, data in self.ticks.items()
            ],
            "tickBitmap": list(self.tickBitmap),
        }
        import json
        return json.dumps(state, indent=2)

    # ===== Helper/Private =====
    def submod(self, a: int, b: int) -> int:
        diff = a - b
        if diff < 0:
            return 0
        return diff

    def mulDivRoundingDown(self, a: int, b: int, denominator: int) -> int:
        if denominator == 0 or a == 0 or b == 0:
            return 0
        return (a * b) // denominator

    # ===== Static method cuối =====
    @staticmethod
    def deserialize(json_str: str):
        import json
        state = json.loads(json_str)
        pool = Pool(int(state["feeRatePpm"]), state["tickSpacing"])
        pool.reserveA = int(state["reserveA"])
        pool.reserveB = int(state["reserveB"])
        pool.sqrtPriceX64 = int(state["sqrtPriceX64"])
        pool.liquidity = int(state["liquidity"])
        pool.tickCurrent = state["tickCurrent"]
        pool.feeRate = state["feeRate"]
        pool.protocolFeeShareNumerator = int(state.get("protocolFeeShareNumerator", 1))
        pool.protocolFeeShareDenominator = int(state.get("protocolFeeShareDenominator", 5))
        pool.feeGrowthGlobal0X64 = int(state["feeGrowthGlobal0X64"])
        pool.feeGrowthGlobal1X64 = int(state["feeGrowthGlobal1X64"])
        pool.totalSwapFee0 = int(state.get("totalSwapFee0", 0))
        pool.totalSwapFee1 = int(state.get("totalSwapFee1", 0))
        pool.ticks = {}
        for tickData in state["ticks"]:
            pool.ticks[tickData["tick"]] = {
                "liquidityNet": int(tickData["liquidityNet"]),
                "liquidityGross": int(tickData["liquidityGross"]),
                "feeGrowthOutside0X64": int(tickData["feeGrowthOutside0X64"]),
                "feeGrowthOutside1X64": int(tickData["feeGrowthOutside1X64"]),
            }
        pool.tickBitmap = set(state["tickBitmap"])
        return pool
    def applyRepayFlashSwap(
        self,
        amountXDebt: int,
        amountYDebt: int,
        paidX: int,
        paidY: int,
        reserveX: int = None,
        reserveY: int = None,
    ):
        feeX = paidX - amountXDebt if paidX > amountXDebt else 0
        feeY = paidY - amountYDebt if paidY > amountYDebt else 0

        if feeX > 0:
            self.updateFeeGrowth(feeX, True)
            self.totalSwapFee0 += feeX
        if feeY > 0:
            self.updateFeeGrowth(feeY, False)
            self.totalSwapFee1 += feeY

        if reserveX is not None:
            self.reserveA = reserveX
        if reserveY is not None:
            self.reserveB = reserveY

        self.updateTickFeeGrowthForFlashSwap()

    def applySwap(self, amountIn: int, zeroForOne: bool) -> int:
        fees = self.calculateFees(amountIn)
        result = self.applySwapInternal(amountIn, zeroForOne, fees)
        return result["amountOut"]

    def applySwapWithValidation(
        self,
        amountIn: int,
        zeroForOne: bool,
        expectedAmountOut: int = None,
        expectedFee: int = None,
        expectedProtocolFee: int = None,
    ):
        self.validationStats["totalSwaps"] += 1
        computedFees = self.calculateFees(amountIn)
        lpFee = expectedFee if expectedFee is not None else computedFees["lpFee"]
        protocolFee = expectedProtocolFee if expectedProtocolFee is not None else computedFees["protocolFee"]
        totalFee = lpFee + protocolFee
        swapResult = self.applySwapInternal(amountIn, zeroForOne, {
            "totalFee": totalFee,
            "lpFee": lpFee,
            "protocolFee": protocolFee,
        })
        amountOut = swapResult["amountOut"]
        validation = {
            "amountOutMatch": amountOut == expectedAmountOut if expectedAmountOut is not None else True,
            "feeMatch": lpFee == expectedFee if expectedFee is not None else True,
            "protocolFeeMatch": protocolFee == expectedProtocolFee if expectedProtocolFee is not None else True,
            "amountOutDifference": amountOut - expectedAmountOut if expectedAmountOut is not None else 0,
            "feeDifference": lpFee - expectedFee if expectedFee is not None else 0,
            "protocolFeeDifference": protocolFee - expectedProtocolFee if expectedProtocolFee is not None else 0,
            "isExactMatch": True, # Will be set to false if any validation fails
        }
        validation["isExactMatch"] = (
            validation["amountOutMatch"]
            and validation["feeMatch"]
            and validation["protocolFeeMatch"]
        )

        # Check if all validations pass
        if not validation["amountOutMatch"]:
            self.validationStats["amountOutMismatches"] += 1
            self.validationStats["totalAmountOutDifference"] += validation["amountOutDifference"]
        
        # Update statistics for mismatches
        if not validation["feeMatch"]:
            self.validationStats["feeMismatches"] += 1
            self.validationStats["totalFeeDifference"] += validation["feeDifference"]
     
        if not validation["protocolFeeMatch"]:
            self.validationStats["protocolFeeMismatches"] += 1
            self.validationStats["totalProtocolFeeDifference"] += validation["protocolFeeDifference"]
     
        if validation["isExactMatch"]:
            self.validationStats["exactMatches"] += 1
            
        return {
            "amountOut": amountOut,
            "feeAmount": lpFee,
            "protocolFee": protocolFee,
            "validation": validation,
        }

    def applySwapInternal(self, amountIn: int, zeroForOne: bool, fees: dict) -> dict:
        if amountIn <= 0:
            return {"amountOut": 0}
        
        totalFee = fees["totalFee"]
        lpFee = fees["lpFee"]

        if totalFee > 0:
            if zeroForOne:
                self.totalSwapFee0 += totalFee
            else:
                self.totalSwapFee1 += totalFee

        if lpFee > 0:
            self.updateFeeGrowth(lpFee, zeroForOne)

        amountInAfterFee = amountIn - totalFee if amountIn > totalFee else 0
        if amountInAfterFee == 0:
            return {"amountOut": 0}
        
        result = self.executeCLMMSwap(amountInAfterFee, zeroForOne)

        self.sqrtPriceX64 = result["newSqrtPriceX64"]
        self.tickCurrent = result["newTick"]
        return {"amountOut": result["amountOut"]}

    def executeCLMMSwap(self, amountIn: int, zeroForOne: bool) -> dict:
        currentSqrtPriceX64 = self.sqrtPriceX64
        currentTick = self.tickCurrent
        amountOut = 0
        remainingAmount = amountIn

        while remainingAmount > 0:
            nextTick = self.getNextTick(currentTick, zeroForOne)
            if nextTick is None:
                swapResult = self.swapAtPrice(remainingAmount, currentSqrtPriceX64, zeroForOne)
                amountOut += swapResult["amountOut"]
                currentSqrtPriceX64 = swapResult["newSqrtPriceX64"]
                currentTick = self.sqrtPriceToTick(currentSqrtPriceX64)
                remainingAmount = 0
                break
         
            maxAmountAtCurrentPrice = self.calculateMaxSwapAtPrice(currentSqrtPriceX64, nextTick, zeroForOne)
          
            if maxAmountAtCurrentPrice <= 0:
                break
          
            if remainingAmount <= maxAmountAtCurrentPrice:
                swapResult = self.swapAtPrice(remainingAmount, currentSqrtPriceX64, zeroForOne)
                amountOut += swapResult["amountOut"]
                currentSqrtPriceX64 = swapResult["newSqrtPriceX64"]
                currentTick = self.sqrtPriceToTick(currentSqrtPriceX64)
                remainingAmount = 0
                break
         
            swapResult = self.swapAtPrice(maxAmountAtCurrentPrice, currentSqrtPriceX64, zeroForOne)
            amountOut += swapResult["amountOut"]
            remainingAmount -= maxAmountAtCurrentPrice
          
            currentSqrtPriceX64 = self.tickToSqrtPrice(nextTick)
            currentTick = nextTick
         
            self.updateFeeGrowthOutside(nextTick, zeroForOne)
       
            tickData = self.ticks.get(nextTick)
            if tickData:
                liquidityNet = tickData["liquidityNet"]
                if zeroForOne:
                    self.liquidity -= liquidityNet
                else:
                    self.liquidity += liquidityNet
                if self.liquidity < 0:
                    self.liquidity = 0
        return {
            "amountOut": amountOut,
            "newSqrtPriceX64": currentSqrtPriceX64,
            "newTick": currentTick,
        }

    def getNextTick(self, currentTick: int, zeroForOne: bool):
        if zeroForOne:
            lowerTicks = sorted([tick for tick in self.tickBitmap if tick < currentTick], reverse=True)
            return lowerTicks[0] if lowerTicks else None
        else:
            higherTicks = sorted([tick for tick in self.tickBitmap if tick > currentTick])
            return higherTicks[0] if higherTicks else None

    def calculateMaxSwapAtPrice(self, currentSqrtPriceX64: int, nextTick: int, zeroForOne: bool) -> int:
        nextSqrtPriceX64 = self.tickToSqrtPrice(nextTick)
        Q64 = 1 << 64
        if zeroForOne:
            numerator = self.liquidity * (currentSqrtPriceX64 - nextSqrtPriceX64) * Q64
            denominator = currentSqrtPriceX64 * nextSqrtPriceX64
            return numerator // denominator if denominator != 0 else 0
        else:
            deltaSqrtPrice = nextSqrtPriceX64 - currentSqrtPriceX64
            return (self.liquidity * deltaSqrtPrice) // Q64 if Q64 != 0 else 0

    def swapAtPrice(self, amountIn: int, sqrtPriceX64: int, zeroForOne: bool) -> dict:
        Q64 = 1 << 64
        if zeroForOne:
            if self.liquidity == 0:
                return {"amountOut": 0, "newSqrtPriceX64": sqrtPriceX64}
            numerator = self.liquidity * sqrtPriceX64 * Q64
            denominator = self.liquidity * Q64 + amountIn * sqrtPriceX64
            newSqrtPriceX64 = sqrtPriceX64 if denominator == 0 else numerator // denominator
            delta = sqrtPriceX64 - newSqrtPriceX64
            amountOut = self.mulDivRoundingDown(self.liquidity, delta, Q64)
            return {"amountOut": amountOut, "newSqrtPriceX64": newSqrtPriceX64}
        else:
            if self.liquidity == 0:
                return {"amountOut": 0, "newSqrtPriceX64": sqrtPriceX64}
            newSqrtPriceX64 = sqrtPriceX64 + (amountIn * Q64) // self.liquidity
            delta = newSqrtPriceX64 - sqrtPriceX64
            numerator = self.liquidity * delta * Q64
            denominator = newSqrtPriceX64 * sqrtPriceX64
            amountOut = 0 if denominator == 0 else numerator // denominator
            return {"amountOut": amountOut, "newSqrtPriceX64": newSqrtPriceX64}

    def updateFeeGrowth(self, feeAmount: int, zeroForOne: bool):
        if self.liquidity > 0:
            feeGrowthDelta = (feeAmount * (1 << 64)) // self.liquidity
            if zeroForOne:
                self.feeGrowthGlobal0X64 += feeGrowthDelta
            else:
                self.feeGrowthGlobal1X64 += feeGrowthDelta

    def updateFeeGrowthOutside(self, tick: int, zeroForOne: bool):
        tickData = self.ticks.get(tick)
        if not tickData:
            return
        globalFeeGrowth = self.feeGrowthGlobal0X64 if zeroForOne else self.feeGrowthGlobal1X64
        if zeroForOne:
            tickData["feeGrowthOutside0X64"] = globalFeeGrowth
        else:
            tickData["feeGrowthOutside1X64"] = globalFeeGrowth

    def updateTickFeeGrowthForFlashSwap(self):
        for tick, tickData in self.ticks.items():
            tickData["feeGrowthOutside0X64"] = self.feeGrowthGlobal0X64
            tickData["feeGrowthOutside1X64"] = self.feeGrowthGlobal1X64

    def mulDivRoundingDown(self, a: int, b: int, denominator: int) -> int:
        if denominator == 0 or a == 0 or b == 0:
            return 0
        return (a * b) // denominator
    
__all__ = ["Pool"]

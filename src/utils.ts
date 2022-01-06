// @ts-nocheck

import {
  BN_MAX,
  calculateBaseAssetValue,
  calculatePositionPNL,
  PARTIAL_LIQUIDATION_RATIO,
  TEN_THOUSAND,
  ZERO,
} from "@drift-labs/sdk";
import axios from "axios";
import BN from "bn.js";

export const HIGH_PRIORITY = new BN(1500);
export const MID_PRIORITY = new BN(1501);

export const getTotalPositionValue = ({ clearingHouse, positions }) => {
  return positions.reduce((positionValue, marketPosition) => {
    const market = clearingHouse.getMarket(marketPosition.marketIndex);

    return positionValue.add(calculateBaseAssetValue(market, marketPosition));
  }, ZERO);
};

export const getMarginRatio = ({ positions, clearingHouse, collateral }) => {
  const totalPositionValue = getTotalPositionValue({
    positions,
    clearingHouse,
  });

  if (totalPositionValue.eq(ZERO)) {
    return BN_MAX;
  }

  return collateral.mul(TEN_THOUSAND).div(totalPositionValue);
};

export const getUnrealizedPNL = ({ withFunding, clearingHouse, positions }) => {
  return positions.reduce((pnl, marketPosition) => {
    const market = clearingHouse.getMarket(marketPosition.marketIndex);
    return pnl.add(calculatePositionPNL(market, marketPosition, withFunding));
  }, ZERO);
};

export const canBeLiquidated = ({ positions, collateral, clearingHouse }) => {
  const marginRatio = getMarginRatio({ positions, collateral, clearingHouse });
  const canLiquidate = marginRatio.lte(new BN(628));

  return [canLiquidate, marginRatio];
};

export const getRatio = ({ positions, collateral, clearingHouse }) => {
  let funding = getUnrealizedPNL({
    withFunding: true,
    clearingHouse,
    positions,
  });

  let totalCollateral = collateral.add(funding);

  const marginRatio = getMarginRatio({
    positions,
    collateral: totalCollateral,
    clearingHouse,
  });

  // slightly higher because we are simulating it anyways.

  if (marginRatio.lte(new BN(PARTIAL_LIQUIDATION_RATIO))) {
    return ["liquidate", marginRatio];
  }

  if (marginRatio.gt(new BN(2000))) {
    return ["lowPriority", marginRatio];
  }
  return marginRatio.lte(new BN(1000))
    ? ["highPriority", marginRatio]
    : ["mediumPriority", marginRatio];
};

export const getData = async ({
  authorityKeys,
  positionKeys,
  clearingHouse,
}) => {
  const { program } = clearingHouse;
  const dataToDecode = await axios.post(
    program.provider.connection._rpcEndpoint,
    [
      {
        jsonrpc: "2.0",
        id: "1",

        method: "getMultipleAccounts",
        params: [
          positionKeys,
          {
            commitment: "confirmed",
          },
        ],
      },
      {
        jsonrpc: "2.0",
        id: "1",

        method: "getMultipleAccounts",
        params: [
          authorityKeys,
          {
            commitment: "confirmed",
          },
        ],
      },
    ],
  );

  const [positionResults, userResults] = dataToDecode.data;

  const positionData = positionResults.result.value.map((userPositions, i) => {
    const myBuffer = Buffer.from(userPositions.data[0], userPositions.data[1]);
    const details = program.account.userPositions._coder.accounts.decode(
      program.account.userPositions._idlAccount.name,
      myBuffer,
    );
    return details;
  });

  const userData = userResults.result.value.map((user, i) => {
    const myBuffer = Buffer.from(user.data[0], user.data[1]);
    const details = program.account.user._coder.accounts.decode(
      program.account.user._idlAccount.name,
      myBuffer,
    );
    return details;
  });

  return [positionData, userData];
};

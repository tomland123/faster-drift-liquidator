//@ts-nocheck =D
import { BN, Provider } from "@project-serum/anchor";
import axios from "axios";

import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import {
  ClearingHouse,
  initialize,
  DriftEnv,
  getUserAccountPublicKey,
} from "@drift-labs/sdk";
// not sure what the new wallet on anchor is.
import { Wallet } from "@drift-labs/sdk/node_modules/@project-serum/anchor";
import { getData, getRatio } from "./utils";
import { chunk } from "lodash";

require("dotenv").config();

export async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// I recommend you read this from bottom to top.

// sets different priorities

const lowPriority = {};
const mediumPriority = {};
const highPriority = {};

let counter = 0;

const main = async () => {
  // Initialize Drift SDK
  const sdkConfig = initialize({ env: "mainnet-beta" as DriftEnv });

  // Set up the Wallet and Provider
  const privateKey = process.env.KEY; // stored as an array string

  const keypair = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(privateKey)),
  );
  const wallet = new Wallet(keypair);

  // Set up the Connection
  const rpcAddress = process.env.RPC; // you will probably need your own private rpc or throttle this bot manually as it is very fast and spams a lot of txn

  const connection = new Connection(rpcAddress);

  // Set up the Provider
  const provider = new Provider(connection, wallet, Provider.defaultOptions());

  // Check SOL Balance
  const lamportsBalance = await connection.getBalance(wallet.publicKey);
  console.log("SOL balance:", lamportsBalance / 10 ** 9);

  // Set up the Drift Clearing House
  const clearingHousePublicKey = new PublicKey(
    sdkConfig.CLEARING_HOUSE_PROGRAM_ID,
  );
  const clearingHouse = ClearingHouse.from(
    connection,
    provider.wallet,
    clearingHousePublicKey,
  );
  await clearingHouse.subscribe();

  const updateUserAccounts = async () => {
    // You shouldnt use user.all(). It  doesnt scale well right now.
    // Needs to take a filter and only do 1000 at a time until it finishes.
    // Then it should always look for the newest 1000 every 10 minutes and stop when it finds a duplicate.
    // further optimization would be to add a redis instance
    const programUserAccounts = await clearingHouse.program.account.user.all();

    let program = clearingHouse.program;

    const userAccountPubkeys = await Promise.all(
      programUserAccounts.map(
        async (i) =>
          await getUserAccountPublicKey(
            clearingHouse.program.programId,
            i.account.authority,
          ),
      ),
    );

    let userDetailArray = userAccountPubkeys.map((userAccountPubkey, i) => {
      return {
        userAccountPublickey: userAccountPubkey,
        ...programUserAccounts[i],
      };
    });

    const listofPositions = [];

    let counter = 0;

    userDetailArray.forEach((item, index) => {
      if (!listofPositions[counter]) {
        listofPositions[counter] = [];
      }
      listofPositions[counter].push(item.account.positions.toString());

      if ((index + 1) % 100 === 0 && index > 1) {
        counter++;
      }
    });

    const initData = async (arrayOfUsers, startIndex = 0) => {
      // getMultipleAccounts is significantly faster than clearingHouse.program.account.user.all().
      // We already know the data and pubkey and dont need to fetch it based off the account.

      const dataToDecode = await axios.post(
        program.provider.connection._rpcEndpoint,
        {
          jsonrpc: "2.0",
          id: "1",

          method: "getMultipleAccounts",
          params: [
            arrayOfUsers,
            {
              commitment: "confirmed",
            },
          ],
        },
      );

      const userData = dataToDecode.data.result.value.map(
        (userPositions, i) => {
          const myBuffer = Buffer.from(
            userPositions.data[0],
            userPositions.data[1],
          );
          const details = program.account.userPositions._coder.accounts.decode(
            program.account.userPositions._idlAccount.name,
            myBuffer,
          );

          let user = userDetailArray[startIndex + i];

          const ratio = getRatio({
            positions: details.positions,
            clearingHouse,
            collateral: user.account.collateral,
          });

          // we want to divide things into buckets to query faster -- ideally in something like redis.
          // This is a small optimization but it will help this scale to millions of accounts.

          if (ratio[0] === "highPriority" || ratio[0] === "liquidate") {
            highPriority[user.account.authority.toString()] = {
              positions: details.positions,
              user,
              marginRatio: ratio[1],
            };
            // removes things in the incorrect buckets
            if (lowPriority[user.account.authority.toString()]) {
              delete lowPriority[user.account.authority.toString()];
            }

            if (mediumPriority[user.account.authority.toString()]) {
              delete mediumPriority[user.account.authority.toString()];
            }
          }

          if (ratio[0] === "mediumPriority") {
            mediumPriority[user.account.authority.toString()] = {
              positions: details.positions,
              user,
              marginRatio: ratio[1],
            };
            if (lowPriority[user.account.authority.toString()]) {
              delete lowPriority[user.account.authority.toString()];
            }

            if (highPriority[user.account.authority.toString()]) {
              delete highPriority[user.account.authority.toString()];
            }
          }

          if (ratio[0] === "lowPriority") {
            lowPriority[user.account.authority.toString()] = {
              positions: details.positions,
              user,
              marginRatio: ratio[1],
            };
            if (mediumPriority[user.account.authority.toString()]) {
              delete mediumPriority[user.account.authority.toString()];
            }

            if (highPriority[user.account.authority.toString()]) {
              delete highPriority[user.account.authority.toString()];
            }
          }
        },
      );

      return userData;
    };

    await Promise.all(
      listofPositions.map(async (account, i) => {
        let number = i * 100;
        return await initData(account, number);
      }),
    );
  };

  const checkLeverageUsers = async (priorityType) => {
    let priorityKeys = Object.keys(priorityType);

    const positionKeys = priorityKeys.map((key) => {
      return priorityType[key].user.account.positions.toString();
    });

    const authorityKeys = priorityKeys.map((key) => {
      return priorityType[key].user.publicKey.toString();
    });

    let authorityKeyArray = chunk(authorityKeys, 100);
    let positionKeyArray = chunk(positionKeys, 100);

    await Promise.all(
      positionKeyArray.map(async (_, index) => {
        const [positions, user] = await getData({
          authorityKeys: authorityKeyArray[index],
          positionKeys: positionKeyArray[index],
          clearingHouse,
        });

        positions.forEach(async (positionDetails, i) => {
          let ratio = getRatio({
            positions: positionDetails.positions,
            clearingHouse,
            collateral: user[i].collateral,
          });

          // calls the liquidator

          if (ratio[0] === "liquidate") {
            clearingHouse
              .liquidate(
                priorityType[user[i].authority.toString()].user
                  .userAccountPublickey,
              )
              .then((tx) => {
                console.log(`Liquidated user: ${user.authority} Tx: ${tx}`);
              });
            counter = 1;
          }
          if (ratio[0] === "highPriority") {
            highPriority[user[i].authority.toString()] = {
              positions: positionDetails.positions,
              user: {
                publicKey:
                  priorityType[user[i].authority.toString()].user.publicKey,
                userAccountPublickey:
                  priorityType[user[i].authority.toString()].user
                    .userAccountPublickey,

                account: user[i],
              },
              marginRatio: ratio[1],
            };

            if (lowPriority[user[i].authority.toString()]) {
              delete lowPriority[user[i].account.authority.toString()];
            }

            if (mediumPriority[user[i].authority.toString()]) {
              delete mediumPriority[user[i].authority.toString()];
            }
          } else if (ratio[0] === "mediumPriority") {
            mediumPriority[user[i].authority.toString()] = {
              positions: positionDetails.positions,
              user: {
                publicKey:
                  priorityType[user[i].authority.toString()].user.publicKey,
                userAccountPublickey:
                  priorityType[user[i].authority.toString()].user
                    .userAccountPublickey,

                account: user[i],
              },
              marginRatio: ratio[1],
            };
            if (lowPriority[user[i].authority.toString()]) {
              delete lowPriority[user[i].authority.toString()];
            }

            if (highPriority[user[i].authority.toString()]) {
              delete highPriority[user[i].authority.toString()];
            }
          } else if (ratio[0] === "lowPriority") {
            lowPriority[user[i].authority.toString()] = {
              positions: positionDetails.positions,
              user: {
                publicKey:
                  priorityType[user[i].authority.toString()].user.publicKey,
                userAccountPublickey:
                  priorityType[user[i].authority.toString()].user
                    .userAccountPublickey,

                account: user[i],
                marginRatio: ratio[1],
              },
            };

            if (mediumPriority[user[i].authority.toString()]) {
              delete mediumPriority[user[i].authority.toString()];
            }

            if (highPriority[user[i].authority.toString()]) {
              delete highPriority[user[i].authority.toString()];
            }
          }
        });
      }),
    );
  };

  // recursively loop the code after its initialized

  const initAndLiquidateUsers = async () => {
    // checks if users can be liquidated

    if (counter % 24000 === 0 && counter > 0) {
      try {
        await checkLeverageUsers(lowPriority);
        counter++;
        await sleep(100);
        await initAndLiquidateUsers();
      } catch (e) {
        console.log(e);
      }
    } else if (counter % 1200 === 0 && counter > 0) {
      try {
        await checkLeverageUsers(mediumPriority);

        counter++;
        await sleep(100);
        await initAndLiquidateUsers();
      } catch (e) {
        console.log(e);
      }
    } else if (counter >= 0) {
      try {
        await checkLeverageUsers(highPriority);
        counter++;
        await sleep(100);
        await initAndLiquidateUsers();
      } catch (e) {
        console.log(e);
      }
    } else {
      counter++;
    }

    await sleep(100);

    await initAndLiquidateUsers();
  };

  // this calls the initializer above //
  await updateUserAccounts();

  await initAndLiquidateUsers();
};

main();

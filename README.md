## Drift Faster Liquidator

# There are two main things this bot submission solves: 

1. Removing websockets.   Websockets are notoriously slow on solana. It takes upwards of minutes to fetch data from a web socket and so I do not think that it is currently a scalable solution as of this current solana version.   

2. The core of the bot prefetches the data that is important and calls getMultipleAccounts instead of getProgramAccounts.   Even with incredibly strong computers and just 7000 accounts, it still takes the average drift liquidator multiple seconds to parse through all the data using getProgramAccounts. This bot solves this problem by bucketing users into different priority schedules and then runs different queries over the ones that are close to liquidations vs. the ones who are inactive.   

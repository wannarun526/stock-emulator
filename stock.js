( async () => {
    const request = require("request-promise");
    const { MongoClient } = require("mongodb");
    const  moment = require('moment');
    const uri = "mongodb://localhost:27017";
    const client = await new MongoClient(uri, { useUnifiedTopology: true }).connect()
    const db = client.db('stocks');
    const txCol = db.collection("txs");

    // 計算SMA
    const calSMA = (inputList, updateIndex, day) => {
        var total = 0;

        for(var i = 0; i < day; i++){
            total += inputList[updateIndex - i ]['close']
        }

        return Math.round(total / day);
    }

    // 整理各股資料
    const freshSMA = async(targetObj) => {

        if(targetObj.FTX){
            // 找TxList
            const dbTxList = await txCol.find().sort({ date: 1 }).toArray()

            const MtxList = dbTxList.filter(item => item.futures_id === "MTX")
            const promises = MtxList.map(async (item, index) => {
                let sma5 = sma11 = null;

                if (index >= 4) sma5 = calSMA(MtxList, index, 5)

                if (index >= 10) sma11 = calSMA(MtxList, index, 11)

                await txCol.updateOne({ _id: item['_id'] }, { $set: { sma5, sma11 }} )
            })

            await Promise.all(promises);
            console.log("FTX over")
        }
    }

    //爬取台指期每日盤後數據
    const requestFTX = async (product, startDate, endDate) => {
        const ftxUrl = "https://api.finmindtrade.com/api/v4/data"
        const response = await request({
            url: ftxUrl,
            method: "GET",
            qs: {
                dataset: 'TaiwanFuturesDaily',
                data_id: product,
                start_date: moment(startDate).format("YYYY-MM-DD"),
                end_date: moment(endDate).format("YYYY-MM-DD"),
                device: 'web'
            },
        });

        const start = moment.utc(startDate)
        const end = moment.utc(endDate)
        let now = start;


        while (now.isSameOrBefore(end)){
            const inputDate = now.format("YYYY-MM-DD");
            const dateMoment = moment.utc(inputDate);
            const yearMonthThis = dateMoment.format("YYYYMM");
            const yearMonthNext = moment.utc(inputDate).add(1, "M").format("YYYYMM")
            const dataList = JSON.parse(response).data.filter(item =>
                (item.contract_date === yearMonthThis || item.contract_date === yearMonthNext) &&
                item.date === inputDate
            );

            const positionData = dataList.find(item => item.trading_session === "position");
            const afterData = dataList.find(item => item.trading_session === "after_market");


            // 有開市有資料 => 下一步
            if(positionData && afterData) {
                // 找TXList
                const TXList = await txCol.find().toArray();

                const newData = {
                    date: inputDate,
                    futures_id: product,
                    contract_date: positionData.contract_date,
                    open: afterData?.open || positionData?.open,
                    max: Math.max(positionData.max, afterData?.max || positionData?.max),
                    min: Math.min(positionData.min, afterData?.min || positionData?.min),
                    close: positionData.settlement_price || positionData.close,
                }

                console.log("newData 111:", newData)

                await txCol.insertOne(newData)
            }
            console.log(inputDate + '-over');

            now = now.add(1, 'd');
        }
    }

    // 範圍日期爬取盤後數據
    const requestRange = async(targetObj, startDate, endDate) => {
        if(targetObj.FTX){
            // await requestFTX("TX", now.format("YYYYMMDD"))
            await requestFTX("MTX", startDate, endDate)
        }
    }

    // 分析策略 X 百分比
    const startPercent = async(percent = 9999999999) => {
        // 找TxList
        const dbTxList = await txCol.find().sort({ date: 1 }).toArray();

        const MtxList = dbTxList.filter(item => item.futures_id === "MTX");

        const tradeList = [];

        MtxList.forEach((item, index) => {
            const d1Item = MtxList[index - 1];
            const d2Item = MtxList[index - 2];
            const d3Item = MtxList[index - 3];
            const lastTrade = tradeList[tradeList.length - 1];

            if(!lastTrade || (lastTrade.buyDate && lastTrade.sellDate)){
                // 未買入
                if(
                    item.sma5 && item.sma11 && d1Item &&
                    item.sma5 > item.sma11 &&
                    d1Item.sma5 <= d1Item.sma11
                ){
                    // 突破 => 買入
                    tradeList.push({
                        buyDate: item.date,
                        buyPrice: item.close,
                        buyGoalPrice: Math.ceil(Math.ceil(item.close * percent)/ 10) * 10,
                        sellDate: null,
                        sellPrice: 0,
                        profit: 0,
                    })
                }
                return;
            }

            if(lastTrade?.buyDate && !lastTrade?.sellDate){
                // 已買入未售出
                if(
                    item.sma5 && item.sma11 && d1Item &&
                    item.max >= lastTrade.buyGoalPrice
                ){
                    // 達到 1% 目標 => 獲利售出
                    tradeList[tradeList.length - 1].sellDate = item.date;
                    tradeList[tradeList.length - 1].sellPrice = lastTrade.buyGoalPrice;
                    tradeList[tradeList.length - 1].profit = lastTrade.buyGoalPrice - lastTrade.buyPrice;
                    return;
                }

                if(
                    item.sma5 && item.sma11 && d1Item && d2Item && d3Item &&
                    (
                        (item.sma5 < item.sma11 && d1Item.sma5 >= d1Item.sma11) ||
                        (item.close < item.open && d1Item.close < d1Item.open && d2Item.close < d2Item.open) // 連三黑k
                    )
                ){
                    // 交叉 => 售出
                    tradeList[tradeList.length - 1].sellDate = item.date;
                    tradeList[tradeList.length - 1].sellPrice = item.close;
                    tradeList[tradeList.length - 1].profit = item.close - lastTrade.buyPrice;
                    return;
                }

            }
        })

        const winList = tradeList.filter(trade => trade.profit > 0);
        const totalProfit = winList.map(trade => trade.profit).reduce((a, b) => a + b );
        console.log("tradeList 111:", tradeList);
        console.log("percent 111:", percent);
        console.log("total times 111:", tradeList.length);
        console.log("win times 111:", winList.length);
        console.log("total profit 111:", totalProfit);
        console.log("expectation 111:", totalProfit / tradeList.length);
        console.log("------------------------------------------------------");
    }

    const startSmallPeak = async(percent = 100, dayExpect = 10) => {
        // 找TxList
        const dbTxList = await txCol.find().sort({ date: 1 }).toArray();

        const MtxList = dbTxList.filter(item => item.futures_id === "MTX");
        const result = [];

        MtxList.forEach((item, index) => {
            const d2Item = MtxList[index - 2];
            const d1Item = MtxList[index - 1];

            if(d1Item && d2Item){
                const yesterdayIncreasePercent = Math.round(((d1Item.close - d2Item.close) / d2Item.close) * 100 * 100) / 100;

                if(yesterdayIncreasePercent > percent && d1Item.sma5 > d1Item.sma11){

                    const dayResult = (item.close - item.open);

                    result.push(dayResult);

                    // console.log(item.date, ':', yesterdayIncreasePercent, ', dayResult:', dayResult);
                }
            }
        })

        const wins = result.filter(item => item > 0);
        const totalProfits = result.reduce((a, b) => a + b, 0);

        console.log("percent: ", percent, 'dayExpect:', dayExpect);
        console.log('summary total:', result.length, 'true: ', wins.length, 'win rate: ', wins.length / result.length)
        console.log('total profits: ', totalProfits, 'expectation: ', totalProfits/result.length);
        console.log("------------------------------------------------------");
    }

    const targetObj = { FTX: true };
    // 擷取資料 20170101 ~ 20240217
    // await requestRange(targetObj, "20240127", "20240217");

    // 整理資料
    // await freshSMA(targetObj);

    // 分析策略 X 百分比
    // for (let index = 1; index < 21; index++) {
        // await startPercent(1 + 0.01 * 7);

    // }

    // 分析策略 單日漲幅
    // for (let index1 = 0; index1 < 30; index1++) {
    //     await startSmallPeak(0.4 + index1 * 0.1, 10);
    //     console.log("**************************************************");
    // }


    await client.close();
})()

( async () => {
    const request = require("request-promise");
    const {MongoClient} = require('mongodb');
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
            MtxList.forEach(async (item, index) => {
                let sma5 = sma11 = null;

                if (index >= 4) sma5 = calSMA(MtxList, index, 5)

                if(index >= 10) sma11 = calSMA(MtxList, index, 11)

                await txCol.updateOne({ _id: item['_id'] }, { $set: { sma5, sma11 }} )
            })
            console.log("FTX over")
        }
    }

    //爬取台指期每日盤後數據
    const requestFTX = async (product, inputDate) => {
        const ftxUrl = "https://api.finmindtrade.com/api/v4/data"
        const dateMoment = moment.utc(inputDate);
        const yearMonthThis = dateMoment.format("YYYYMM");
        const yearMonthNext = moment.utc(inputDate).add(1, "M").format("YYYYMM")
        const response = await request({
            url: ftxUrl,
            method: "GET",
            qs: {
                dataset: 'TaiwanFuturesDaily',
                data_id: product,
                start_date: inputDate,
                end_date: inputDate,
                device: 'web'
            },
        });

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
                open: afterData.open,
                max: Math.max(positionData.max, afterData.max),
                min: Math.min(positionData.min, afterData.min),
                close: positionData.settlement_price || positionData.close,
            }

            console.log("newData 111:", newData)

            await txCol.insertOne(newData)
        }
        console.log(inputDate + '-over');
    }

    // 範圍日期爬取盤後數據
    const requestRange = async(targetObj, startDate, endDate) => {
        // date array
        const start = moment.utc(startDate)
        const end = moment.utc(endDate)
        let now = start;
        while (now.isSameOrBefore(end) ){
            if(targetObj.FTX){
                // await requestFTX("TX", now.format("YYYYMMDD"))
                await requestFTX("MTX", now.format("YYYY-MM-DD"))
            }

            //停止秒數防止過度擷取
            await new Promise(resolve => setTimeout(resolve, 5 * 1000));
            now = now.add(1, 'd');
        }

    }

    // 分析策略 1百分比
    const startOnePercent = async() => {
        // 找TxList
        const dbTxList = await txCol.find().sort({ date: 1 }).toArray();

        const MtxList = dbTxList.filter(item => item.futures_id === "MTX");

        const tradeList = [];

        MtxList.forEach((item, index) => {
            const yesterdayItem = MtxList[index - 1];
            const lastTrade = tradeList[tradeList.length - 1];

            if(!lastTrade || (lastTrade.buyDate && lastTrade.sellDate)){
                // 未買入
                if(
                    item.sma5 && item.sma11 && yesterdayItem &&
                    item.sma5 > item.sma11 &&
                    yesterdayItem.sma5 <= yesterdayItem.sma11
                ){
                    // 突破 => 買入
                    tradeList.push({
                        buyDate: item.date,
                        buyPrice: item.close,
                        buyGoalPrice: Math.ceil(Math.ceil(item.close * 1.14)/ 10) * 10,
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
                    item.sma5 && item.sma11 && yesterdayItem &&
                    item.max >= lastTrade.buyGoalPrice
                ){
                    // 達到 1% 目標 => 獲利售出
                    tradeList[tradeList.length - 1].sellDate = item.date;
                    tradeList[tradeList.length - 1].sellPrice = lastTrade.buyGoalPrice;
                    tradeList[tradeList.length - 1].profit = lastTrade.buyGoalPrice - lastTrade.buyPrice;
                    return;
                }

                if(
                    item.sma5 && item.sma11 && yesterdayItem &&
                    item.sma5 < item.sma11 &&
                    yesterdayItem.sma5 >= yesterdayItem.sma11
                ){
                    // 交叉 => 賠錢售出
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
        console.log("total times 111:", tradeList.length);
        console.log("win times 111:", winList.length);
        console.log("total profit 111:", totalProfit);
        console.log("expectation 111:", totalProfit / tradeList.length);
    }

    const targetObj = { FTX: true };
    // 擷取資料 20210101 ~ 20220101
    // await requestRange(targetObj, "20210101", "20220101");

    // 整理資料
    // await freshSMA(targetObj);

    // 分析策略 1百分比
    await startOnePercent();

    // 分析策略 均線交叉
    // await startCross();

    await client.close();
})()

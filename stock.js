( async () => {
    const request = require("request-promise");
    const {MongoClient} = require('mongodb');
    const  moment = require('moment');
    const uri = "mongodb://localhost:27017";
    const client = await new MongoClient(uri, { useUnifiedTopology: true }).connect()
    const db = client.db('stocks');
    const stockListCol = db.collection("stockNames");
    const stocksCol = db.collection("stocks");
    const txCol = db.collection("txs");

    // 股價文字轉為float
    const transferToDecimal = (inputStr) => {
        const result = parseFloat(inputStr.replace(/[,]/g, ""))
        return result ? result : 0;
    }
    // 計算SMA
    const calSMA = (inputList, updateIndex, day)=>{
        var total = 0;

        for(var i = 0; i < day; i++){
            total += inputList[updateIndex - i ]['close']
        }

        return Math.round( (total / day) * 100) / 100;
    }

    // 整理各股資料
    const freshSMA = async(targetObj) =>{

        if(targetObj.FTX){
            // 找TxList
            const dbTxList = await txCol.find().toArray()

            const MtxList = dbTxList.filter(item => item.futures_id === "MTX")
            MtxList.sort((a, b) => a.date > b.date ? 1 : (a.date < b.date ? -1 : 0))
            for(var i = 0 ; i < MtxList.length; i++){
                const Mtxquery = {_id: MtxList[i]['_id']}
                var mtxSma5 = mtxSma11= null;

                if (i >= 4){
                    mtxSma5 = calSMA(MtxList, i, 5)
                }
                if(i >= 10){
                    mtxSma11 = calSMA(MtxList, i, 11)
                }
                await txCol.updateOne(Mtxquery,
                    { $set: {
                        sma5: mtxSma5,
                        sma11: mtxSma11,
                    }})
            }
            console.log("FTX over")
        }
    }

    //爬取台指期每日盤後數據
    const requestFTX = async (product, inputDate) =>{
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


        // 有開市有資料 => 下一步
        if(dataList.length ){
            // 找TXList
            const TXList = await txCol.find().toArray();

            const positionData = dataList.find(item => item.trading_session === "position");
            const afterData = dataList.find(item => item.trading_session === "after_market");

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
    const requestRange = async(targetObj, startDate, endDate) =>{
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

    const targetObj = { FTX: true };
    // 擷取資料
    await requestRange(targetObj, "20240101", "20240128");

    // 整理資料
    await freshSMA(targetObj);

    await client.close();


})()

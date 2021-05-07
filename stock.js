( async () => {
    const request = require("request-promise");
    const {MongoClient} = require('mongodb');
    const  moment = require('moment');
    const uri = "mongodb://yunshanghong:password@localhost:27017";
    const client = await new MongoClient(uri).connect()
    
    const db = client.db('stocks');
    const stockListCol = db.collection("stockList");
    const stocksCol = db.collection("stocks");
    const txCol = db.collection("TX");
    
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


    // 爬取上市股票數據
    const requestTwe = async (date) => {
        try{
            let tweUrl = "https://www.twse.com.tw/exchangeReport/MI_INDEX?response=json&date=" + date + "&type=ALLBUT0999"
            const response = await request({
                url: tweUrl,
                method: "GET",
            })
            const data = JSON.parse(response)['data9']

            // 有開市有資料 => 下一步
            if(data){
                // 找stockList
                const dbStockList = await stockListCol.find().toArray()
                // 找stocks
                const dbStocks = await stocksCol.find().toArray();

                const newStockList = []
                const newStocks = []
                // 把每一行拿出來
                for(var row of data){
                    //row[0]: 證券代號
                    //row[1]: 證券名稱
                    //row[2]: 成交股數
                    //row[3]: 成交金額
                    //row[5]: 開盤價
                    //row[6]: 最高價
                    //row[7]: 最低價
                    //row[8]: 收盤價
                    //row[9]: 漲跌符號
                    //row[10]: 漲跌幅度

                    // 證券代號為4碼
                    if(row[0].length === 4){

                        if(row[0] === "0050"){
                            console.log(row)
                        }
                        // 找不到就新增一筆
                        if(!dbStockList.find((item) => item.code === row[0] && item.name === row[1])){
                            newStockList.push({code: row[0], name: row[1]})
                        }
                        
                        // 找不到就新增
                        if(!dbStocks.find((item)=> item.code === row[0] && item.name === row[1] && moment.utc(date).isSame(item.date))){
                            newStocks.push({
                                code: row[0],
                                name: row[1],
                                date: moment.utc(date).toDate(),
                                open: transferToDecimal(row[5]),
                                high: transferToDecimal(row[6]),
                                low: transferToDecimal(row[7]),
                                close: transferToDecimal(row[8]),
                                volumn: transferToDecimal(row[2]) / 1000
                            })
                        }
                    }
                }

                console.log("for - over")
                // 最後一次新增
                if(newStockList.length !== 0){
                    await stockListCol.insertMany(newStockList);
                }
                if(newStocks.length !== 0){
                    await stocksCol.insertMany(newStocks);
                }

            }
            console.log(date + '-over');
        }catch(error){
            console.log("error")
            console.log(error)
        }
    }

    // 整理各股資料
    const freshSMA = async(targetObj) =>{
        if(targetObj.TWE){
            // 找stockList
            const dbStockList = await stockListCol.find().toArray()
            // 找stocks
            const dbStocks = await stocksCol.find().toArray();

            for(var row of dbStockList){
                const stockAllDate = dbStocks.filter((item)=> item.code === row.code && item.name === row.name);
                stockAllDate.sort((a, b) => a.date > b.date ? 1 : (a.date < b.date ? -1 : 0))
                console.log(row.name + " start")
                var ystSma5;
                var ystSma10;
                var ystSma20;
                var ystAllBuyCond;
                for(var key in stockAllDate){
                    const todayData = stockAllDate[key];
                    const query = {_id: todayData['_id']}
                    var sma5 = null;
                    var sma10 = null;
                    var sma20 = null;
                    var sma60 = null;
                    var sma120 = null;
                    var sma240 = null;
                    var buyCond1 = null;
                    var buyCond2 = null;
                    var buyCond3 = null;
                    var buyCond4 = null;
                    if (key >= 4)
                        sma5 = calSMA(stockAllDate, key, 5)
                    if(key >= 9)
                        sma10 = calSMA(stockAllDate, key, 10)
                    if(key >= 19){
                        sma20 = calSMA(stockAllDate, key, 20)

                        // 條件1 收盤價大於5日, 10日, 20日均
                        buyCond1 = todayData['close'] >= sma5 && todayData['close'] >= sma10 && todayData['close'] >= sma20;
                        // 條件2 5日, 10日, 20日均線向上
                        buyCond2 = sma5 >= ystSma5 && sma10 >= ystSma10 && sma20 >= ystSma20;
                        // 條件3 收盤價大於月線未來10日扣抵值
                        const maxSma20 = [];
                        for(var i=10; i < 20; i++){
                            maxSma20.push(stockAllDate[key - i]['close'])
                        }
                        buyCond3 = todayData['close'] > Math.max(...maxSma20)
                        // 條件4 昨日前三條件不符合且今日符合
                        buyCond4 = !ystAllBuyCond && (buyCond1 && buyCond2 && buyCond3)
                    }
                    if(key >= 59)
                        sma60 = calSMA(stockAllDate, key, 60)
                    if(key >= 119)
                        sma120 = calSMA(stockAllDate, key, 120)
                    if(key >= 239)
                        sma240 = calSMA(stockAllDate, key, 240)
                    
                    ystSma5 = sma5;
                    ystSma10 = sma10;
                    ystSma20 = sma20;
                    ystAllBuyCond = buyCond1 && buyCond2 && buyCond3;
                    await stocksCol.updateOne(query, 
                        { $set: { 
                            sma5: sma5, 
                            sma10: sma10, 
                            sma20: sma20, 
                            sma60: sma60, 
                            sma120: sma120, 
                            sma240: sma240,
                            buyCond1: buyCond1,
                            buyCond2: buyCond2,
                            buyCond3: buyCond3,
                            buyCond4: buyCond4,
                        }})
                    
                }
                console.log(row.name + " over")
            }
        }
        
        if(targetObj.FTX){
            // 找TxList
            const dbTxList = await txCol.find().toArray()

            const TxList = dbTxList.filter(item => item.code === "TX")
            const MtxList = dbTxList.filter(item => item.code === "MTX")
            TxList.sort((a, b) => a.date > b.date ? 1 : (a.date < b.date ? -1 : 0))
            MtxList.sort((a, b) => a.date > b.date ? 1 : (a.date < b.date ? -1 : 0))
            for(var i = 0 ; i < TxList.length; i++){
                const Txquery = {_id: TxList[i]['_id']}
                const Mtxquery = {_id: MtxList[i]['_id']}
                var txSma5 = mtxSma5 = txSma10 = mtxSma10 = txSma20 = mtxSma20 = null;
                var txSma60 = mtxSma60 = txSma120 = mtxSma120 = txSma240 = mtxSma240 = null;

                if (i >= 4){
                    txSma5 = calSMA(TxList, i, 5)
                    mtxSma5 = calSMA(MtxList, i, 5)
                }
                if(i >= 9){
                    txSma10 = calSMA(TxList, i, 10)
                    mtxSma10 = calSMA(MtxList, i, 10)
                }
                if(i >= 19){
                    txSma20 = calSMA(TxList, i, 20)
                    mtxSma20 = calSMA(MtxList, i, 20)
                }
                if(i >= 59){
                    txSma60 = calSMA(TxList, i, 60)
                    mtxSma60 = calSMA(MtxList, i, 60)
                }
                if(i >= 119){
                    txSma120 = calSMA(TxList, i, 120)
                    mtxSma120 = calSMA(MtxList, i, 120)
                }
                if(i >= 239){
                    txSma240 = calSMA(TxList, i, 240)
                    mtxSma240 = calSMA(MtxList, i, 240)
                }
                
                await txCol.updateOne(Txquery, 
                    { $set: { 
                        sma5: txSma5, 
                        sma10: txSma10, 
                        sma20: txSma20, 
                        sma60: txSma60, 
                        sma120: txSma120, 
                        sma240: txSma240
                    }})
                await txCol.updateOne(Mtxquery,
                    { $set: { 
                        sma5: mtxSma5, 
                        sma10: mtxSma10, 
                        sma20: mtxSma20, 
                        sma60: mtxSma60, 
                        sma120: mtxSma120, 
                        sma240: mtxSma240
                    }})
            }
            console.log("FTX over")
        }
    }
    
    //爬取台指期每日盤後數據
    const requestFTX = async (product, inputData) =>{
        const ftxUrl = "https://www.taifex.com.tw/cht/3/dlFutDataDown"
        const dateMoment = moment.utc(inputData)
        const date = dateMoment.format("YYYY/MM/DD")
        const yearMonthThis = dateMoment.format("YYYYMM")
        const yearMonthNext = moment.utc(inputData).add(1, "M").format("YYYYMM")
        let response = await request({
            url: ftxUrl,
            method: "POST",
            form: {
                down_type: 1,
                commodity_id: product,
                queryStartDate: date,
                queryEndDate: date,
            }
        })
        response = response.split("\n").slice(1);

        // 有開市有資料 => 下一步
        if(response[0] ){
            // 找TXList
            const TXList = await txCol.find().toArray()

            //整理當天資料
            const allData = response.map(item => {
                const row = item.split(',')
                if(row[0]){
                    return {
                        code: row[1],
                        name: row[1] + row[2].trim(),
                        month: row[2].trim(),
                        open: row[3],
                        high: row[4],
                        low: row[5],
                        close: row[10] !== '0' ? row[10] : row[6],
                        volumn: row[9]
                    }
                }else{
                    return null
                }
            })

            const monthThis = allData.filter(item => item && item.month === yearMonthThis);
            const monthNext = allData.filter(item => item && item.month === yearMonthNext);

            const todayData = monthThis.length > 0 ? monthThis : monthNext;

            const dayData = todayData.find(item => item.close.indexOf("-") === -1)
            const nightData = todayData.find(item => item.close.indexOf("-") !== -1)
            //data[0] - 交易日期
            //data[1] - 契約
            //data[2] - 到期月份(週別)
            //data[3] - 開盤價
            //data[4] - 最高價
            //data[5] - 最低價
            //data[6] - 收盤價
            //data[9] - 成交量
            
            if(!TXList.find((item)=> item.code === dayData.code && item.name === dayData.name && moment.utc(inputData).isSame(item.date))){
                const newData = {
                    code: dayData.code,
                    name: dayData.name,
                    date: dateMoment.toDate(),
                    open: transferToDecimal(nightData.open),
                    high: Math.max(dayData.high, nightData.high),
                    low: Math.min(dayData.low, nightData.low),
                    close: transferToDecimal(dayData.close),
                    dayVolumn: transferToDecimal(dayData.volumn),
                    nightVolumn: transferToDecimal(nightData.volumn),
                    totalVolumn: transferToDecimal(dayData.volumn) + transferToDecimal(nightData.volumn)
                }

                await txCol.insertOne(newData)
            }
        }
        console.log(date + '-over');
    }

    // 範圍日期爬取盤後數據
    const requestRange = async(targetObj, startDate, endDate) =>{
        // date array
        const start = moment.utc(startDate)
        const end = moment.utc(endDate)
        let now = start;
        while (now.isSameOrBefore(end) ){

            console.log(now.format("YYYYMMDD") + "-start");

            if(targetObj.TWE){
                await requestTwe(now.format("YYYYMMDD"))
            }

            if(targetObj.FTX){
                await requestFTX("TX", now.format("YYYYMMDD"))
                await requestFTX("MTX", now.format("YYYYMMDD"))
            }
            
            //停止秒數防止過度擷取
            await new Promise(resolve => setTimeout(resolve, 5 * 1000));
            now = now.add(1, 'd');
        }

        await freshSMA(targetObj);
    }

    // 已擷取2018-08-01 至 2021-05-07
    await requestRange({FTX: true, TWE: true}, "20180801", "20181231");
    await client.close();
})()

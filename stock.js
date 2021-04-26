( async () => {
    const request = require("request-promise");
    const {MongoClient} = require('mongodb');
    const  moment = require('moment');
    const uri = "mongodb://yunshanghong:password@localhost:27017";
    const client = await new MongoClient(uri).connect()
    
    const db = client.db('stocks');
    const stockListCol = db.collection("stockList");
    const stocksCol = db.collection("stocks");
    
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
    const freshSMA = async() =>{
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

    // 範圍日期爬取上市上櫃資料
    const requestRange = async(startDate, endDate) =>{
        // date array
        const start = moment.utc(startDate)
        const end = moment.utc(endDate)
        let now = start;
        while (now.isSameOrBefore(end) ){

            console.log(now.format("YYYYMMDD") + "-start");
            await requestTwe(now.format("YYYYMMDD"))
            //停止秒數防止過度擷取
            await new Promise(resolve => setTimeout(resolve, 3 * 1000));
            now = now.add(1, 'd');
        }
    }
    
    // 已擷取2019-01-01 至 2021-04-19
    await requestRange("20210420", "20210422");

    await freshSMA();

    await client.close();
})()

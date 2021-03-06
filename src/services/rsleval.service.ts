import config from "config";
import { Service } from "typedi";
import { Connection, getConnection, SelectQueryBuilder } from "typeorm";
import { QuoteData } from "../entities";
import { QuoteDataService } from "./quote-service";

enum RSLevyAlgorithm {
    WEEKLY = "weekly",
    DAILY = "daily"
}

type RSLevyResponseData = {
    securityISIN: string;
    securityName: string;
    instrumentType: string;
    exchangeName: string;
    newestWeeklyClose: Date;
    rslValue: number;
};

type RSLevyWeeklyData = {
    securityISIN: string;
    securityName: string;
    instrumentType: string;
    exchangeName: string;
    lastDayOfWeek: Date;
    lastPriceOfWeek: number;
};

@Service()
class RSLevyService {
    private connection: Connection;

    constructor(private service: QuoteDataService) {
        this.connection = getConnection(config.get("ormconfig.connection"));
    }

    async getRSLevyData(algorithm: RSLevyAlgorithm): Promise<RSLevyResponseData[]> {
        if (algorithm == RSLevyAlgorithm.DAILY) {
            return this.getRSLevyDaily();
        }

        return this.getRSLevyWeekly();
    }

    private async getRSLevyWeekly(): Promise<RSLevyResponseData[]> {
        type TempElemType = {
            isin: string;
            exchange: string;
            items: RSLevyWeeklyData[];
        };

        const queryResult: RSLevyWeeklyData[] = await this.getRawRSLevyData();

        // partition the array of query results into an array where all elements with the same ISIN
        // and exchange are grouped together
        const tempArray = queryResult.reduce((obj: TempElemType[], item: RSLevyWeeklyData) => {
            // find out whether there is already an element with the same ISIN and exchange
            const elem = obj.filter(
                (e: TempElemType) => e.isin === item.securityISIN && e.exchange == item.exchangeName
            );

            if (elem.length === 0) {
                // if not, create a new element
                obj.push({ isin: item.securityISIN, exchange: item.exchangeName, items: [item] });
            } else {
                // ... otherwise add the item data to the existing element
                elem[0].items.push(item);
            }
            return obj;
        }, []);

        // the result array
        const levyResult: RSLevyResponseData[] = [];

        // tempArray is now partitioned; there is exactly one entry for each ISIN/exchange combination
        for (const elem of tempArray) {
            // skip this entry if there's not enough data for the RSL evaluation
            if (elem.items.length < 27) {
                // console.log(`Not enough data for ${elem.isin}@${elem.exchange} -- only ${elem.items.length} weeks`);
                continue;
            }

            // sort all elements by date in descending order; use only the newest 27 elements
            const sortedItems = elem.items
                .sort((a, b) => b.lastDayOfWeek.valueOf() - a.lastDayOfWeek.valueOf())
                .slice(0, 27);

            const newest = sortedItems[0];

            // create a new result entry
            levyResult.push({
                securityISIN: newest.securityISIN,
                securityName: newest.securityName,
                instrumentType: newest.instrumentType,
                exchangeName: newest.exchangeName,
                newestWeeklyClose: newest.lastDayOfWeek,
                rslValue:
                    (newest.lastPriceOfWeek * sortedItems.length) /
                    sortedItems.reduce((sum, elem) => sum + elem.lastPriceOfWeek, 0.0)
            });
        }

        return levyResult;
    }

    private async getRawRSLevyData(): Promise<RSLevyWeeklyData[]> {
        return this.connection
            .createQueryBuilder()
            .select([
                "s.isin AS isin",
                "s.name AS sname",
                "s.type AS itype",
                "e.name AS ename",
                "last_date_of_week",
                "q.quote AS last_price_of_week"
            ])
            .from(QuoteData, "q")
            .leftJoin("q.security", "s")
            .leftJoin("q.exchange", "e")
            .leftJoin(
                (qb) => this.getWeeklyCloseDates(qb.subQuery()),
                "ldows",
                "q.securityId = ldows.sid AND q.exchangeId = ldows.eid"
            )
            .where("q.date = ldows.last_date_of_week")
            .groupBy("sid")
            .addGroupBy("eid")
            .addGroupBy("last_date_of_week")
            .getRawMany()
            .then((rawData) =>
                rawData.map((x) => ({
                    securityISIN: x.isin,
                    securityName: x.sname,
                    instrumentType: x.itype,
                    exchangeName: x.ename,
                    lastDayOfWeek: new Date(x.last_date_of_week),
                    lastPriceOfWeek: Number(x.last_price_of_week)
                }))
            );
    }

    private getWeeklyCloseDates(qb: SelectQueryBuilder<QuoteData>): SelectQueryBuilder<QuoteData> {
        return qb
            .select(["sid", "eid", "MAX(q.date) AS last_date_of_week"])
            .from(QuoteData, "q")
            .leftJoin(
                (qb) => this.getLast28Weeks(qb.subQuery()),
                "weekly",
                "q.securityId = weekly.sid AND q.exchangeId = weekly.eid"
            )
            .where("YEARWEEK(q.date, 3) = weekly.year_week")
            .groupBy("sid")
            .addGroupBy("eid")
            .addGroupBy("weekly.year_week");
    }

    private getLast28Weeks(qb: SelectQueryBuilder<QuoteData>): SelectQueryBuilder<QuoteData> {
        return qb
            .select(["sid", "eid", "YEARWEEK(q.date, 3) AS year_week"])
            .from(QuoteData, "q")
            .leftJoin(
                (qb) => this.getLatestWeekCloseDate(qb.subQuery()),
                "wcds",
                "q.securityId = wcds.sid AND q.exchangeId = wcds.eid"
            )
            .where("q.date <= wcds.close_date")
            .andWhere("q.date > DATE_SUB(wcds.close_date, INTERVAL 28 WEEK)")
            .groupBy("sid")
            .addGroupBy("eid")
            .addGroupBy("YEARWEEK(q.date, 3)");
    }

    private getLatestWeekCloseDate(qb: SelectQueryBuilder<QuoteData>): SelectQueryBuilder<QuoteData> {
        return qb
            .select(["sid", "eid", "MAX(q.date) AS close_date"])
            .from(QuoteData, "q")
            .leftJoin(
                (qb) => this.service.getMinMaxDates(qb.subQuery()),
                "ndates",
                "q.securityId = ndates.sid AND q.exchangeId = ndates.eid"
            )
            .where("q.date <= DATE_SUB(ndates.max_date, INTERVAL ((3 + WEEKDAY(ndates.max_date)) % 7) DAY)")
            .groupBy("sid")
            .addGroupBy("eid");
    }

    private async getRSLevyDaily(): Promise<RSLevyResponseData[]> {
        return this.connection
            .createQueryBuilder()
            .select("sid")
            .addSelect("s.isin", "isin")
            .addSelect("s.name", "sname")
            .addSelect("s.type", "itype")
            .addSelect("eid")
            .addSelect("e.name", "ename")
            .addSelect("max_date")
            .addSelect("q.quote", "close_price")
            .from(QuoteData, "q")
            .innerJoin("q.security", "s")
            .innerJoin("q.exchange", "e")
            .innerJoin(
                (qb) => this.getLatestDate200(qb.subQuery()),
                "md200",
                "q.securityId = md200.sid AND q.exchangeId = md200.eid"
            )
            .where("q.date = md200.max_date")
            .getRawMany()
            .then(async (data) => {
                const result: RSLevyResponseData[] = [];

                for (const row of data) {
                    const { sid, isin, sname, itype, eid, ename, max_date, close_price } = row;
                    const avg = await this.connection
                        .createQueryBuilder()
                        .select(["sid", "eid"])
                        .addSelect("AVG(lat200.price)", "average")
                        .from((qb) => this.getLatest200Rows(qb.subQuery(), sid, eid), "lat200")
                        .getRawOne();

                    result.push({
                        securityISIN: isin,
                        securityName: sname,
                        instrumentType: itype,
                        exchangeName: ename,
                        newestWeeklyClose: new Date(max_date),
                        rslValue: Number(close_price / avg.average)
                    });
                }

                return result;
            });
    }

    private getLatest200Rows(
        qb: SelectQueryBuilder<QuoteData>,
        sid: number,
        eid: number
    ): SelectQueryBuilder<QuoteData> {
        return qb
            .select("q.securityId", "sid")
            .addSelect("q.exchangeId", "eid")
            .addSelect("q.date", "qdate")
            .addSelect("q.quote", "price")
            .from(QuoteData, "q")
            .where("q.securityId = :sid", { sid: sid })
            .andWhere("q.exchangeId = :eid", { eid: eid })
            .orderBy("q.date", "DESC")
            .limit(200);
    }

    private getLatestDate200(qb: SelectQueryBuilder<QuoteData>): SelectQueryBuilder<QuoteData> {
        return qb
            .select("q.securityId", "sid")
            .addSelect("q.exchangeId", "eid")
            .addSelect("MAX(q.date)", "max_date")
            .from(QuoteData, "q")
            .groupBy("sid")
            .addGroupBy("eid")
            .having("COUNT(*) >= 200");
    }
}

export { RSLevyAlgorithm, RSLevyResponseData, RSLevyService };

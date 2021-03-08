import config from "config";

import { Service } from "typedi";
import { getRepository, Repository, SelectQueryBuilder } from "typeorm";

import { AddQuoteDataRequest } from "../dtos";
import { QuoteData, Security } from "../entities";

import { ExchangeService } from "./exchange-service";
import { SecuritiesService } from "./security-service";

type PerformanceIntervalDTO = {
    unit: "day" | "month" | "year";
    count: number;
};

type PerformanceQuotesDTO = {
    securityISIN: string;
    securityName: string;
    instrumentType: string;
    exchangeName: string;
    latestDate: Date;
    latestPrice: number;
    baseDate: Date;
    basePrice: number;
};

type QuoteCountDTO = {
    isin: string;
    exchange: string;
    count: number;
};

@Service()
class QuoteDataService {
    private repository: Repository<QuoteData>;

    constructor(private securityService: SecuritiesService, private exchangeService: ExchangeService) {
        this.repository = getRepository<QuoteData>(QuoteData, config.get("ormconfig.connection"));
    }

    async get(isin: string, exchangeID: number, startDate?: string, endDate?: string): Promise<QuoteData[]> {
        const query = this.createFilteredRowsQuery(isin, exchangeID);

        if (startDate) {
            const startTimeStamp: number = Date.parse(startDate);
            if (!isNaN(startTimeStamp)) {
                // checking the end date makes only sense if the start date is already valid
                // --> we initialise it with the current date
                let end: Date = new Date();
                if (endDate) {
                    // if the end date was actually set in the query params, try parsing it
                    const endTimeStamp: number = Date.parse(endDate);
                    if (!isNaN(endTimeStamp)) {
                        // if it's a valid date, then overwrite the original value
                        // ... otherwise it remains the current date from above
                        end = new Date(endTimeStamp);
                    }
                }

                query.andWhere("q.date BETWEEN :start AND :end", {
                    start: new Date(startTimeStamp).toISOString(),
                    end: end.toISOString()
                });
            }
        }

        return query.getMany();
    }

    async add(data: AddQuoteDataRequest): Promise<void> {
        return this.securityService.getOne({ isin: data.isin }).then(async (security: Security) => {
            const exchange = await this.exchangeService.getOne({ name: data.exchange });
            /*
             * Creates a list of items that need to be inserted or updated. And we really don't care which at this
             * point; we only want to make sure that the latest data is in the repository.
             */
            const itemList: QuoteData[] = [];
            for (const item of data.quotes) {
                const qd = new QuoteData();
                qd.security = security;
                qd.exchange = exchange;
                qd.date = item.date;
                qd.quote = item.quote;
                itemList.push(qd);
            }
            /*
             * Insert or update the entities in the list.
             *
             * Found here: https://github.com/typeorm/typeorm/issues/1090#issuecomment-634391487
             *
             * Works since we made the date, security, and exchange columns a unique combination in the entity.
             */
            this.repository
                .createQueryBuilder()
                .insert()
                .values(itemList)
                .orUpdate({ conflict_target: ["date", "security", "exchange"], overwrite: ["quote"] })
                .execute();
        });
    }

    /**
     * Returns a table of data that can be used for performance calculations.
     *
     * @returns the data table as an array of PerformanceQuotesDTO rows
     *
     * SQL equivalent:
     * ```sql
     * SELECT bdates.isin, bdates.sname, bdates.itype, bdates.ename, bdates.latestDate, bdates.latestPrice, bdates.baseDate, q.quote AS basePrice
     * FROM quotes AS q
     * LEFT JOIN (
     *     -- calculates the base dates (latest dates minus an interval, in this case 1 year)
     *     SELECT lprices.sid, lprices.isin, lprices.sname, lprices.ename, lprices.latestDate, lprices.latestPrice, MAX(q.date) AS baseDate
     *     FROM quotes AS q
     *     LEFT JOIN (
     *         -- adds the share prices to the latest dates
     *         SELECT ldates.sid, ldates.isin, ldates.sname, ldates.ename, ldates.latestDate, q.quote AS latestPrice
     *         FROM quotes AS q
     *         LEFT JOIN (
     *             -- the latest dates for each security
     *             SELECT s.id AS sid, s.isin AS isin, s.name AS sname, e.name AS ename, MAX(q.date) AS latestDate
     *             FROM quotes AS q
     *             LEFT JOIN securities AS s ON q.securityId = s.id
     *             LEFT JOIN exchanges AS e ON q.exchangeId = e.id
     *             GROUP BY s.isin, e.name
     *         ) AS ldates ON q.securityId = ldates.sid
     *         WHERE q.date = ldates.latestDate
     *     ) AS lprices ON q.securityId = lprices.sid
     *     WHERE q.date <= DATE_SUB(lprices.latestDate, INTERVAL 1 YEAR)
     *     GROUP BY lprices.isin, lprices.ename
     * ) AS bdates ON q.securityId = bdates.sid
     * WHERE q.date = bdates.baseDate;
     * ```
     */
    async getPerformanceQuotes(interval: PerformanceIntervalDTO): Promise<PerformanceQuotesDTO[]> {
        return this.repository
            .createQueryBuilder("q")
            .select([
                "bdates.isin",
                "bdates.sname",
                "bdates.itype",
                "bdates.ename",
                "bdates.latestDate",
                "bdates.latestPrice",
                "bdates.baseDate",
                "q.quote AS basePrice"
            ])
            .leftJoin(
                (qb) => this.subQueryReferenceDates(qb.subQuery(), interval),
                "bdates",
                "q.securityId = bdates.sid"
            )
            .where("q.date = bdates.baseDate")
            .getRawMany()
            .then((data) =>
                data.map((x) => ({
                    securityISIN: x.isin,
                    securityName: x.sname,
                    instrumentType: x.itype,
                    exchangeName: x.ename,
                    latestDate: new Date(x.latestDate),
                    latestPrice: Number(x.latestPrice),
                    baseDate: new Date(x.baseDate),
                    basePrice: Number(x.basePrice)
                }))
            );
    }

    /**
     * Query builder for the subquery that adds the base date (i.e. the date that the performance calculation is
     * based on) for each security.
     *
     * @param qb the query builder of the calling query
     * @returns the query builder for the subquery
     *
     * SQL equivalent:
     * ```sql
     * SELECT lprices.sid, lprices.isin, lprices.sname, lprices.itype, lprices.ename, lprices.latestDate, lprices.latestPrice, MAX(q.date) AS baseDate
     * FROM quotes AS q
     * LEFT JOIN (
     *     -- adds the share prices to the latest dates
     *     SELECT ldates.sid, ldates.isin, ldates.sname, ldates.ename, ldates.latestDate, q.quote AS latestPrice
     *     FROM quotes AS q
     *     LEFT JOIN (
     *         -- the latest dates for each security
     *         SELECT s.id AS sid, s.isin AS isin, s.name AS sname, e.name AS ename, MAX(q.date) AS latestDate
     *         FROM quotes AS q
     *         LEFT JOIN securities AS s ON q.securityId = s.id
     *         LEFT JOIN exchanges AS e ON q.exchangeId = e.id
     *         GROUP BY s.isin, e.name
     *     ) AS ldates ON q.securityId = ldates.sid
     *     WHERE q.date = ldates.latestDate
     * ) AS lprices ON q.securityId = lprices.sid
     * WHERE q.date <= DATE_SUB(lprices.latestDate, INTERVAL 1 YEAR)
     * GROUP BY lprices.isin, lprices.ename
     * ```
     */
    private subQueryReferenceDates(
        qb: SelectQueryBuilder<QuoteData>,
        interval: PerformanceIntervalDTO
    ): SelectQueryBuilder<QuoteData> {
        if (interval.count < 1) {
            throw new RangeError("Interval count must be positive");
        }
        const unit = { day: "DAY", month: "MONTH", year: "YEAR" };
        const intvl = `${interval.count} ${unit[interval.unit]}`;

        return qb
            .select([
                "lprices.sid",
                "lprices.isin",
                "lprices.sname",
                "lprices.itype",
                "lprices.ename",
                "lprices.latestDate",
                "lprices.latestPrice",
                "MAX(q.date) AS baseDate"
            ])
            .from(QuoteData, "q")
            .leftJoin((qb) => this.subQueryLatestSharePrices(qb.subQuery()), "lprices", "q.securityId = lprices.sid")
            .where(`q.date <= DATE_SUB(lprices.latestDate, INTERVAL ${intvl})`)
            .groupBy("lprices.isin")
            .addGroupBy("lprices.ename");
    }

    /**
     * Query builder for the subquery that returns the share prices for the latest date for each of the securities.
     *
     * @param qb the query builder of the calling query
     * @returns the query builder for the subquery
     *
     * SQL equivalent:
     * ```sql
     * SELECT ldates.sid, ldates.isin, ldates.sname, ldates.itype, ldates.ename, ldates.latestDate, q.quote AS latestPrice
     * FROM quotes AS q
     * LEFT JOIN (
     *     -- the latest dates for each security
     *     SELECT s.id AS sid, s.isin AS isin, s.name AS sname, e.name AS ename, MAX(q.date) AS latestDate
     *     FROM quotes AS q
     *     LEFT JOIN securities AS s ON q.securityId = s.id
     *     LEFT JOIN exchanges AS e ON q.exchangeId = e.id
     *     GROUP BY s.isin, e.name
     * ) AS ldates ON q.securityId = ldates.sid
     * WHERE q.date = ldates.latestDate
     * ```
     */
    private subQueryLatestSharePrices(qb: SelectQueryBuilder<QuoteData>): SelectQueryBuilder<QuoteData> {
        return qb
            .select([
                "ldates.sid",
                "ldates.isin",
                "ldates.sname",
                "ldates.itype",
                "ldates.ename",
                "ldates.latestDate",
                "q.quote AS latestPrice"
            ])
            .from(QuoteData, "q")
            .leftJoin((qb) => this.subQueryLatestDates(qb.subQuery()), "ldates", "q.securityId = ldates.sid")
            .where("q.date = ldates.latestDate");
    }

    /**
     * Query builder for the subquery that returns the latest date for each of the securities that a share price is
     * stored with.
     *
     * @param qb the query builder of the calling query
     * @returns the query builder for the subquery
     *
     * SQL equivalent:
     * ```sql
     * SELECT s.id AS sid, s.isin AS isin, s.name AS sname, s.type AS itype, e.name AS ename, MAX(q.date) AS latestDate
     * FROM quotes AS q
     * LEFT JOIN securities AS s ON q.securityId = s.id
     * LEFT JOIN exchanges AS e ON q.exchangeId = e.id
     * GROUP BY s.isin, e.name
     * ```
     */
    private subQueryLatestDates(qb: SelectQueryBuilder<QuoteData>): SelectQueryBuilder<QuoteData> {
        return qb
            .select([
                "s.id AS sid",
                "s.isin AS isin",
                "s.name AS sname",
                "s.type AS itype",
                "e.name AS ename",
                "MAX(q.date) AS latestDate"
            ])
            .from(QuoteData, "q")
            .leftJoin("q.security", "s")
            .leftJoin("q.exchange", "e")
            .groupBy("s.isin")
            .addGroupBy("e.name");
    }

    /**
     * Returns the number of quotes stored in the database for the specified security and exchange combination.
     *
     * @param isin the security's ISIN
     * @param exchangeID the exchange ID
     * @returns the number of the quotes stored in the database for the security and exchange combination
     *
     * SQL equivalent:
     * ```sql
     * SELECT s.isin AS isin, e.name AS name, COUNT(*) AS count FROM quotes AS q INNER JOIN securities AS s ON q.securityId = s.id INNER JOIN exchanges AS e ON q.exchangeId = e.id GROUP BY s.id, e.id;
     * ```
     */
    async getQuoteCount(): Promise<QuoteCountDTO[]> {
        return this.createJoinedTablesQuery()
            .groupBy("s.id")
            .addGroupBy("e.id")
            .select("s.isin ", "isin")
            .addSelect("e.name ", "exchange")
            .addSelect("COUNT(*) ", "count")
            .getRawMany()
            .then((rows) => rows.map((x) => ({ isin: x.isin, exchange: x.exchange, count: Number(x.count) })));
    }

    /**
     * Convenience method that returns a (partial) query joining the quotes and the securities and exchanges tables.
     *
     * @returns The query builder instance.
     *
     * SQL equivalent:
     * ```sql
     * SELECT * FROM quotes AS q INNER JOIN securities AS s ON q.securityId = s.id INNER JOIN exchanges AS e ON q.exchangeId = e.id;
     * ```
     */
    private createJoinedTablesQuery(): SelectQueryBuilder<QuoteData> {
        return this.repository.createQueryBuilder("q").innerJoin("q.security", "s").innerJoin("q.exchange", "e");
    }

    /**
     * Convenience method that returns a (partial) query with filtered rows based on a combination of ISIN and
     * exchange ID.
     *
     * @param isin The security's ISIN.
     * @param exchangeID The ID of the exchange we want the quotes for
     * @returns The query builder instance
     *
     * SQL equivalent:
     * ```sql
     * SELECT * FROM quotes AS q INNER JOIN securities AS s ON q.securityId = s.id INNER JOIN exchanges AS e ON q.exchangeId = e.id WHERE s.isin = {isin} AND e.id = {exchangeID};
     * ```
     */
    private createFilteredRowsQuery(isin: string, exchangeID: number): SelectQueryBuilder<QuoteData> {
        return this.createJoinedTablesQuery()
            .where("s.isin = :isin", { isin: isin })
            .andWhere("e.id = :exid", { exid: exchangeID });
    }
}

export { PerformanceIntervalDTO, PerformanceQuotesDTO, QuoteDataService, QuoteCountDTO };

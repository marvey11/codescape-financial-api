import config from "config";
import { Service } from "typedi";
import { getRepository, Repository } from "typeorm";
import { AddQuoteDataRequest } from "../dtos";
import { QuoteData, SecuritiesExchange, Security } from "../entities";
import { ExchangeService } from "./exchange-service";
import { SecuritiesService } from "./security-service";

@Service()
class QuoteDataService {
    private repository: Repository<QuoteData>;

    constructor(private securityService: SecuritiesService, private exchangeService: ExchangeService) {
        this.repository = getRepository<QuoteData>(QuoteData, config.get("ormconfig.connection"));
    }

    async add(data: AddQuoteDataRequest): Promise<void> {
        return this.securityService.getOne({ isin: data.isin }).then((security: Security) => {
            return this.exchangeService.getOne(data.exchangeID).then((exchange: SecuritiesExchange) => {
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
                 * found here: https://github.com/typeorm/typeorm/issues/1090#issuecomment-634391487
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
        });
    }
}

export { QuoteDataService };

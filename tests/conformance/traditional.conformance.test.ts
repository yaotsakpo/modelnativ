import { conformanceSuite } from "./suite.ts";
import { traditionalImpl } from "./traditional.adapter.ts";
conformanceSuite(traditionalImpl);

// Phonetic tables ported unchanged from ai-frontend/backend/names/en_names.py.
// These generate fictional language-inspired names, not authentic cultural names.
export type NameGender = "masculine" | "feminine" | "neutral";
export type WeightedFragment = readonly [string, number];
export interface NameStyleDefinition {
  key: string;
  description: string;
  starts: readonly WeightedFragment[];
  middles: readonly WeightedFragment[];
  endings: Record<NameGender, readonly WeightedFragment[]>;
  syllableWeights: readonly number[];
  joiners: readonly string[];
}
export const NAME_STYLES = {

  japanese: {
    key: "japanese",
    description: "Japanese-inspired, clean open syllables",
    starts: [["ka", 8], ["ki", 5], ["ko", 6], ["sa", 7], ["shi", 5], ["su", 3], ["ta", 5], ["to", 6], ["na", 7], ["ni", 4], ["ha", 4], ["hi", 3], ["ma", 7], ["mi", 6], ["mo", 4], ["ra", 5], ["ri", 5], ["re", 4], ["yo", 4], ["yu", 5], ["a", 4], ["e", 2], ["i", 2], ["o", 3]],
    middles: [["ra", 7], ["ri", 6], ["na", 7], ["no", 5], ["ka", 6], ["ko", 4], ["mi", 7], ["ma", 5], ["yu", 4], ["yo", 3], ["sa", 5], ["shi", 4], ["ta", 4], ["to", 4], ["ne", 5], ["ha", 3], ["ki", 5], ["ru", 5], ["re", 4]],
    endings: {
      masculine: [["to", 8], ["ro", 6], ["ki", 5], ["ya", 5], ["ru", 4], ["ma", 3], ["sei", 2]],
      feminine: [["na", 8], ["mi", 7], ["ka", 6], ["ri", 6], ["yo", 4], ["ha", 3], ["ne", 4]],
      neutral: [["ri", 7], ["na", 7], ["ki", 6], ["ru", 6], ["mi", 6], ["to", 5], ["ya", 5]],
    },
    syllableWeights: [10, 55, 30, 5],
    joiners: [""],
  },
  romance: {
    key: "romance",
    description: "Romance-inspired, lyrical and flowing",
    starts: [["val", 7], ["ser", 7], ["mar", 6], ["lor", 6], ["cel", 5], ["rav", 4], ["bel", 5], ["cor", 4], ["del", 4], ["ver", 4], ["sal", 4], ["luc", 4], ["ari", 5], ["elio", 3], ["cas", 5], ["ren", 5], ["tia", 3], ["vio", 3]],
    middles: [["a", 7], ["e", 6], ["i", 6], ["o", 5], ["el", 5], ["ar", 5], ["er", 4], ["in", 4], ["ian", 3], ["av", 3], ["or", 4], ["ess", 2], ["ali", 3], ["eri", 3]],
    endings: {
      masculine: [["o", 8], ["io", 5], ["en", 5], ["el", 4], ["ar", 4], ["is", 3], ["an", 5]],
      feminine: [["a", 10], ["ia", 7], ["ella", 4], ["ina", 5], ["elle", 3], ["ara", 4], ["isa", 3]],
      neutral: [["e", 6], ["en", 6], ["el", 5], ["is", 5], ["a", 5], ["ian", 3]],
    },
    syllableWeights: [10, 55, 30, 5],
    joiners: [""],
  },
  germanic: {
    key: "germanic",
    description: "Germanic-inspired, sturdy and weighty",
    starts: [["ald", 5], ["bern", 5], ["brand", 5], ["ger", 5], ["hald", 5], ["rik", 5], ["wald", 5], ["helm", 4], ["fred", 4], ["gar", 5], ["wer", 4], ["dran", 3], ["stein", 2], ["vor", 4], ["kar", 5], ["hart", 4]],
    middles: [["er", 6], ["en", 5], ["ar", 5], ["old", 3], ["rik", 4], ["wald", 3], ["mund", 3], ["gar", 3], ["in", 4], ["ulf", 2]],
    endings: {
      masculine: [["ric", 6], ["mund", 4], ["hard", 5], ["ulf", 4], ["mar", 4], ["win", 4], ["er", 5]],
      feminine: [["a", 6], ["hild", 5], ["gard", 4], ["lind", 5], ["wyn", 3], ["trud", 3], ["ara", 3]],
      neutral: [["en", 6], ["win", 5], ["mar", 4], ["lin", 4], ["rik", 4], ["ald", 3]],
    },
    syllableWeights: [10, 55, 30, 5],
    joiners: [""],
  },
  slavic: {
    key: "slavic",
    description: "Slavic-inspired, crisp consonants and rich endings",
    starts: [["zor", 6], ["mir", 5], ["vel", 5], ["drag", 5], ["stan", 4], ["rad", 5], ["bor", 5], ["ves", 4], ["mil", 5], ["yar", 4], ["nov", 3], ["kaz", 4], ["vlad", 3], ["sor", 4], ["dar", 4], ["zven", 3]],
    middles: [["a", 5], ["o", 5], ["i", 5], ["en", 4], ["ov", 4], ["ev", 3], ["sl", 2], ["mir", 3], ["rad", 3], ["an", 4], ["il", 3]],
    endings: {
      masculine: [["ov", 6], ["ek", 5], ["an", 5], ["ir", 4], ["or", 4], ["en", 4], ["islav", 2]],
      feminine: [["a", 8], ["ina", 6], ["eva", 5], ["ika", 4], ["ava", 4], ["ena", 5], ["ira", 4]],
      neutral: [["en", 6], ["ir", 5], ["in", 5], ["a", 4], ["ek", 4], ["ov", 3]],
    },
    syllableWeights: [10, 55, 30, 5],
    joiners: [""],
  },
  celtic: {
    key: "celtic",
    description: "Celtic-inspired, airy with lyrical consonants",
    starts: [["ae", 4], ["caer", 4], ["bryn", 5], ["eira", 4], ["gwyn", 4], ["lir", 5], ["maer", 4], ["ryn", 5], ["tal", 5], ["fin", 5], ["cair", 4], ["eil", 4], ["bran", 4], ["mor", 5], ["wen", 4], ["kel", 4]],
    middles: [["a", 6], ["ae", 4], ["ei", 4], ["wyn", 3], ["rin", 4], ["lin", 4], ["eth", 3], ["an", 5], ["or", 4], ["el", 4]],
    endings: {
      masculine: [["an", 6], ["wyn", 4], ["ric", 3], ["ren", 5], ["ion", 3], ["eth", 3]],
      feminine: [["wen", 6], ["elle", 4], ["wyn", 3], ["ira", 5], ["eth", 4], ["iel", 3]],
      neutral: [["en", 6], ["ryn", 5], ["el", 5], ["eth", 4], ["wen", 4], ["ir", 4]],
    },
    syllableWeights: [10, 55, 30, 5],
    joiners: [""],
  },
  arabic: {
    key: "arabic",
    description: "Arabic-inspired, flowing root-like consonant rhythm",
    starts: [["zar", 6], ["qal", 4], ["sam", 6], ["naz", 5], ["ram", 5], ["far", 5], ["jal", 5], ["kar", 5], ["az", 4], ["mar", 5], ["sal", 5], ["dar", 4], ["raz", 4], ["hal", 4], ["yas", 4]],
    middles: [["a", 7], ["i", 6], ["u", 4], ["ar", 4], ["ir", 4], ["an", 4], ["al", 4], ["im", 3], ["ah", 3], ["un", 2]],
    endings: {
      masculine: [["im", 5], ["an", 6], ["ir", 6], ["al", 4], ["ad", 5], ["ar", 4]],
      feminine: [["a", 8], ["ira", 5], ["ara", 5], ["iya", 4], ["ana", 5], ["ah", 4]],
      neutral: [["in", 5], ["an", 6], ["ar", 5], ["al", 5], ["im", 4], ["a", 4]],
    },
    syllableWeights: [10, 55, 30, 5],
    joiners: [""],
  },
  nordic: {
    key: "nordic",
    description: "Nordic-inspired, compact and sharp",
    starts: [["eir", 4], ["hal", 5], ["tor", 5], ["sig", 5], ["var", 5], ["sten", 4], ["jor", 5], ["ulf", 4], ["fre", 4], ["skar", 4], ["run", 5], ["vid", 4], ["arn", 5], ["lev", 3], ["bren", 4]],
    middles: [["a", 5], ["e", 5], ["i", 4], ["or", 4], ["en", 4], ["ar", 4], ["rik", 3], ["ulf", 2], ["in", 3]],
    endings: {
      masculine: [["ar", 6], ["en", 6], ["rik", 4], ["ulf", 3], ["or", 4], ["in", 4]],
      feminine: [["a", 8], ["yn", 4], ["ira", 4], ["rid", 4], ["na", 5], ["dis", 3]],
      neutral: [["en", 6], ["ar", 5], ["in", 5], ["yr", 3], ["el", 4]],
    },
    syllableWeights: [10, 55, 30, 5],
    joiners: [""],
  },
  finnic: {
    key: "finnic",
    description: "Finnic-inspired, vowel-rich and rhythmic",
    starts: [["kai", 6], ["vei", 5], ["lai", 5], ["sai", 4], ["mi", 6], ["ta", 5], ["haa", 3], ["lei", 5], ["no", 4], ["vil", 4], ["rai", 4], ["el", 4], ["kuu", 3], ["suo", 3], ["ani", 4]],
    middles: [["la", 5], ["li", 5], ["na", 5], ["ni", 5], ["ra", 5], ["ri", 5], ["ta", 4], ["kka", 2], ["nne", 2], ["va", 4], ["sa", 4]],
    endings: {
      masculine: [["nen", 5], ["ri", 5], ["ko", 4], ["to", 4], ["la", 4], ["mi", 3]],
      feminine: [["la", 6], ["na", 6], ["ri", 5], ["sa", 5], ["lia", 4], ["kka", 3]],
      neutral: [["nen", 5], ["la", 5], ["ri", 5], ["na", 5], ["va", 4]],
    },
    syllableWeights: [10, 55, 30, 5],
    joiners: [""],
  },
  persian: {
    key: "persian",
    description: "Persian-inspired, lyrical and elegant",
    starts: [["dar", 5], ["sar", 5], ["nav", 4], ["mehr", 3], ["ros", 4], ["par", 5], ["sha", 5], ["az", 4], ["nil", 4], ["far", 5], ["yas", 4], ["del", 4], ["bah", 3], ["zar", 4]],
    middles: [["a", 7], ["i", 6], ["an", 5], ["ar", 5], ["in", 4], ["esh", 3], ["av", 3], ["ir", 4], ["ya", 3]],
    endings: {
      masculine: [["an", 6], ["ir", 5], ["ad", 4], ["ar", 5], ["in", 4], ["esh", 3]],
      feminine: [["a", 7], ["ara", 5], ["ira", 5], ["ina", 4], ["esh", 3], ["ane", 3]],
      neutral: [["an", 6], ["in", 5], ["ar", 5], ["esh", 4], ["a", 4]],
    },
    syllableWeights: [10, 55, 30, 5],
    joiners: [""],
  },
} as const satisfies Record<string, NameStyleDefinition>;
export type NameStyleKey = keyof typeof NAME_STYLES;

// Eden League manager identities & negotiation personalities.
// Transcribed verbatim from the league's GM personalities reference. These seed
// the `managers` map in league state. The two user-controlled clubs (the
// contract-exempt teams) carry the literal "USER CONTROLLED" personality and
// are never given an AI manager.
export interface ManagerSeed {
  name: string;
  personality: string;
}

export const USER_CONTROLLED_PERSONALITY = "USER CONTROLLED";

// Keyed by exact roster team name.
export const MANAGER_SEEDS: Record<string, ManagerSeed> = {
  "Spams": { name: "USER CONTROLLED", personality: USER_CONTROLLED_PERSONALITY },
  "Gugu Team": { name: "USER CONTROLLED", personality: USER_CONTROLLED_PERSONALITY },

  "Vegetables and Fruits": {
    name: "Brockoli",
    personality:
      "Easy to negotiate with, polite, and laid-back. Low trading tolerance; accepts fair or slightly unfavorable trades if presented nicely.",
  },
  "Kookch United": {
    name: "Thomas Tomato",
    personality:
      "Sour when trading, highly reluctant to make any changes to his squad unless offered incredible upside. Extremely high trading tolerance; requires the user to heavily overpay.",
  },
  "Cocos": {
    name: "Danny",
    personality:
      "Unconventional, completely unpredictable, known to make decisions that baffle people, but has struck historically amazing deals. Random trading tolerance; might accept a bizarre trade or reject a perfect one on a whim.",
  },
  "Nicoland Republic": {
    name: "Paviar",
    personality:
      "An old veteran who used to play for Nicoland before finding fame at Wondo Condo. On the nicer side. Fair trading tolerance; values legacy, respect, and reliable players.",
  },
  "Dangerous Journeys": {
    name: "John Bunny",
    personality:
      "A seasoned negotiator, suit-and-tie manager. Quiet but inwardly calculating. High trading tolerance; will silently squeeze the user for extra value or draft capital.",
  },
  "Socks": {
    name: "Bombas",
    personality:
      "A firecracker personality. Harsh, unforgiving, uses rough language. His team is his number one and only priority. Aggressive negotiator; completely dismisses sob stories or weak offers.",
  },
  "Brownies": {
    name: "Chris Plop",
    personality:
      "Witty, fun-loving character with a nice personality, but sometimes lacks a sense of professionalism. Moderate trading tolerance; can be distracted by exciting or flashing player attributes rather than tactical fits.",
  },
  "Egypts": {
    name: "Pharaoh",
    personality:
      "Rules over his team with an iron hand, highly respected. Speaks with a very heavy tone and minimal words. Rigid negotiator; state your final offer clearly, as he does not engage in long back-and-forth bartering.",
  },
  "Grogles FC": {
    name: "Lantern",
    personality:
      "A young manager, bright and energetic. Balanced trading tolerance; heavily favors young prospects with high potential or physical stats.",
  },
  "Fish": {
    name: "Salmon",
    personality:
      "A jumpy character. Uses a demanding tone and harsh language when he wants something, but ironically is also quick to change his mind. Unstable negotiator; might reject an offer, then accept it if re-proposed with a slight text alteration.",
  },
  "Choki Choki Baba": {
    name: "Bulldog",
    personality:
      "A calmer, older manager. Knows exactly how to get what he wants using words. Expert negotiator; will counter-propose with words that make his bad offer sound amazing.",
  },
  "Lights": {
    name: "Light",
    personality:
      "Owner and manager. Disliked by many, but built the highest-rated team in the league and is pushing for a title. High trading tolerance; prioritizes keeping his present squad over future success.",
  },
  "Eden Ultimate Team 2": {
    name: "Boombox",
    personality:
      "Loud, fast-speaking, good in an argument, and uses words to convince people to do his bidding. High trading tolerance; expects to win every argument and asset-swap.",
  },
  "Creams": {
    name: "Basil",
    personality:
      "Humble character who did exceedingly well building his team from the ground up. Loved by everyone. Extremely fair trading tolerance; prioritizes fair-play, mutual benefit, and club loyalty.",
  },
  "Wondo Condo": {
    name: "Wondo",
    personality:
      "One of the greatest players in Eden League History, now coaching his former team. Respected, strong, and demanding. Strict negotiator; demands high-quality, high-rating leadership players.",
  },
  "Vipers": {
    name: "Cobra",
    personality:
      "Uses a quiet tone, yet subtly powerful. Commands great presence and usually gets whatever he asks for. Formidable negotiator; rarely compromises.",
  },
  "Edeks": {
    name: "Dak",
    personality:
      "Invests in the future. Always ready to make a deal for young prospects or straight cash. Dynamic negotiator; will sell veterans instantly if offered young talent or financial upside.",
  },
  "Scoops": {
    name: "Dimmy Ploinkers",
    personality:
      "Chubby man with a quiet personality. A crowd pleaser, soft, and conformative. Low trading tolerance; easily swayed by pressure or public perception.",
  },
  "Grampatomnon": {
    name: "Grandpa Tom",
    personality:
      "A jolly, 71-year-old manager who lacks cutthroat negotiation skills. Has a lot of advisors and is sometimes used as a puppet. Highly vulnerable negotiator; deals can easily go through, but advisors might randomly intervene to alter terms.",
  },
  "Shoc Shoc": {
    name: "Steven",
    personality:
      "Also known as Thief'n Steven. By far the fiercest personality in the league, with red hair and wild eyes. Zero regard for feelings; scares people into giving him what he wants. Toxic negotiator; will insult the user's players, demand absurd overpayments, and attempt outright highway robbery.",
  },
  "Isaiahs": {
    name: "Isaiah",
    personality:
      "Another owner/manager. Hard to make deals with due to his immense love for his players. Has excellent relationships with his team and protects them financially. High trading tolerance; almost never trades away his long-term players unless they explicitly ask to leave.",
  },
  "Edenak's": {
    name: "Bullet",
    personality:
      "Possesses a cutthroat mentality that has been effective since day one. Lifted his team from the bottom of the 2nd division to 1st division playoff contenders in just two years. Elite negotiator; focused entirely on cold, hard efficiency, optimization, and ruthless upward mobility.",
  },
};

export interface ManagerRecord {
  name: string;
  personality: string;
  pendingGeneration?: boolean;
  // Public reputation in the league (0-100). Drifts each week with standings
  // form + extreme harshness penalty. Used to scale how much this manager's
  // press-conference / DM words move morale & relations.
  respect?: number;
  // Running average of the harshness of this manager's own press-conference
  // answers (0 = always cheery, 0.5 = balanced, 1 = always vitriolic).
  harshness?: number;
}

// Build the full managers map for a given set of teams. Teams without a seed
// (e.g. renamed/custom clubs) get a neutral interim manager so the map is
// always complete.
export function buildManagers(teamOrder: string[]): Record<string, ManagerRecord> {
  const out: Record<string, ManagerRecord> = {};
  for (const name of teamOrder) {
    const seed = MANAGER_SEEDS[name];
    out[name] = seed
      ? { name: seed.name, personality: seed.personality }
      : { name: "Interim Manager", personality: "A steady, even-handed caretaker negotiator with a balanced, fair trading tolerance." };
  }
  return out;
}

export function isUserControlledPersonality(personality: string): boolean {
  return personality.trim().toUpperCase() === USER_CONTROLLED_PERSONALITY;
}

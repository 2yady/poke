(async function installPB() {
  "use strict";
  if (globalThis.__PB_DESKTOP_V1__) return globalThis.__PB_DESKTOP_V1__.status();
  const entry = [...document.querySelectorAll('link[rel="modulepreload"]')]
    .find((link) => /\/assets\/main-[^/]+\.js$/.test(new URL(link.href).pathname));
  if (!entry) throw Error("游戏模块尚未加载，请稍后重试");
  const { App } = await import(entry.href);
  if (typeof App?.prototype.openRun !== "function") throw Error("游戏版本不兼容：找不到开局入口");
  const originalOpen = App.prototype.openRun;
  let app = null, hooked = null, lastError = "", auraAt = 0, ranked = false;

  const LIMIT = { damage: 3, area: 2.5, attackSpeed: 2, moveSpeed: 2.5, auraDamage: 120, auraRadius: 16, pickup: 8 };
  const clamp = (v, max) => Math.min(Math.max(v, 1), max);
  const jitter = (v) => v * (0.92 + Math.random() * 0.16);

  let options = {
    safeMode: true, strictRanked: false,
    god: false, softGod: false,
    magnet: false, pickup: 1, damage: 1, area: 1,
    attackSpeed: 1, moveSpeed: 1, aura: false, auraRadius: 12, auraDamage: 50,
    captureSure: false, noFlee: false, autoCapture: true,
    // —— 自动化 ——
    autoRun: false,        // 自动跑图：移动放风筝 + 自动升级 + 自动技能
    autoLevel: true,       // 自动选升级卡（配合 autoRun 生效）
    autoSkill: true,       // 自动放大招
    autoClaim: true,       // 菜单里自动领取每日/每周任务
    autoMenu: true,        // 对局结束后点「菜单」回首页
    autoLoot: true,        // 自动开宝箱/免费精灵球
    autoShop: true,        // 自动走商店
    autoBoss: true,        // 自动打守护者/换区域
    autoBless: true,       // 自动开祝福祭坛（领祝福）
    autoRes: true,         // 自动领黄金岩石 / 树果
    autoChallenge: true,   // 自动接受挑战祭坛
    autoBill: true,        // 技能满级后自动用正辉的机器融合
    autoDitto: true,       // 百变怪：复制一个道具
    autoSnorlax: true,     // 卡比兽：免费祝福 / 金币
    autoLoopRun: false,    // 一局结束后回菜单领成就/任务 → ESC → 开始新游戏（无人值守连开）
    smartPick: true,       // 按当前角色收益挑选技能/道具（关掉则取第一张）
    allowCursed: false,    // 是否开诅咒宝箱（会加难度+伏击）
    lootRange: 42,         // 只理会这个半径内的交互物
    kiteNear: 6,           // 距敌太近(<=)后退
    kiteFar: 11,           // 距敌太远(>=)靠近
    // —— 模拟真人 ——
    humanize: true,        // 总开关：噪声/平滑/意图切换/失误/随机节拍
    reaction: 200,         // 反应延迟(ms)，人约 150-320
    smooth: 0.22,          // 输出一阶低通系数(越小越像手，但太慢会死)
    noise: 0.35,           // 手抖强度
    mistakeRate: 0.035,    // 每秒犯错概率
    ultMin: 3200,          // 大招最小间隔(ms)
    ultMax: 6800,          // 大招最大间隔(ms)
    pickMin: 800,          // 选卡最早延迟(ms)
    pickMax: 2500,         // 选卡最晚延迟(ms)
  };
  let queue = { active: false, items: [], current: null, completed: 0, error: "", autoWeaken: true, run: null };
  let auto = { picks: 0, moves: 0, claims: 0, menus: 0, uiPatched: false, skillAt: 0, claimAt: 0, menuAt: 0, menuDoneFor: null };
  // 挂起的选卡/领奖回调：showLevelUp 被我们接管后先存这里，由看门狗兜底触发，
  // 避免 setTimeout 里 cb 抛异常被吞掉导致整个对局卡在 modal 状态
  let pendingPick = null;
  // ===== 拟人层状态 =====
  const human = {
    sx: 0, sy: 0,             // 平滑后的摇杆输出
    nx: 0, ny: 0,             // OU 噪声
    intent: "kite",           // 当前意图
    intentUntil: 0,           // 意图到期时间
    pendingIntent: null,      // 延迟生效的意图（反应时间）
    pendingAt: 0,
    mistakeUntil: 0,          // 失误持续时间
    mistakeDir: 1,
    holdUntil: 0,             // 停顿（发呆）
    ultNext: 0,               // 下次大招时间
  };
  const rnd = (a, b) => a + Math.random() * (b - a);
  const randn = () => (Math.random() + Math.random() + Math.random() - 1.5) / 1.5; // ≈N(0,1)

  function isRanked(run) {
    try {
      if (!run) return false;
      if (run.ranked === true) return true;
      const t = run.meta?.ticket;
      return !!(t && (t.targets || t.id));
    } catch { return false; }
  }
  function effective() {
    const o = { ...options };
    if (o.safeMode && o.strictRanked && ranked) {
      o.damage = 1; o.area = 1; o.attackSpeed = 1; o.moveSpeed = 1; o.aura = false; o.god = false;
    }
    if (o.safeMode) {
      o.damage = clamp(o.damage, LIMIT.damage);
      o.area = clamp(o.area, LIMIT.area);
      o.attackSpeed = clamp(o.attackSpeed, LIMIT.attackSpeed);
      o.moveSpeed = clamp(o.moveSpeed, LIMIT.moveSpeed);
      o.pickup = Math.min(o.pickup, LIMIT.pickup);
      o.auraRadius = Math.min(o.auraRadius, LIMIT.auraRadius);
      o.auraDamage = Math.min(o.auraDamage, LIMIT.auraDamage);
    }
    return o;
  }

  function stopQueue(error = "") { queue.active = false; queue.error = error; }
  function usable() {
    const run = app?.run;
    return run && !run.coop && !["dead", "over"].includes(run.state) ? run : null;
  }
  // 只要开了任意一个"走过去拿东西"的开关，就需要走路逻辑。
  // 之前这些目标全部写在 autoMove() 里、而 autoMove 只在 autoRun 时调用，
  // 于是面板上「自动开箱 / 领精灵球」「自动祝福祭坛」看着能勾、实际角色原地不动。
  function lootWanted() {
    return !!(options.autoLoot || options.autoShop || options.autoBless ||
      options.autoRes || options.autoChallenge || options.autoBill || options.autoBoss ||
      options.autoDitto || options.autoSnorlax);
  }

  // ===== 自动选升级卡：包住 ui.showLevelUp，直接调 cb(offer) =====
  // ===== 选卡智能评分：按当前角色真正吃收益的词条排序 =====
  // 词条优先级：伤害 > 范围 > 攻速 > 生命 > 幸运 > 移速 > 拾取 > 跳跃
  // 招式满级：bundle 里 yS() 判定融合用的是硬编码 8（不是字段）
  const MOVE_MAX_LV = 8;
  // ===== 融合配方表（从 bundle 的 lS = [...jx,...Nx,...Ix,...Wx,...Xx,...eS,...nS,iS] 导出）=====
  // 79 条双招式招牌融合："招式A|招式B|融合key|图鉴号"
  const FUSION_PAIRS_RAW = "razor-leaf|solar-beam|fu-1|1;fire-spin|flamethrower|fu-4|4;rapid-spin|hydro-pump|fu-7|7;electro-ball|thunder|fu-25|25;string-shot|bug-buzz|fu-10|10;poison-sting|poison-jab|fu-13|13;wing-attack|hurricane|fu-16|16;hyper-fang|super-fang|fu-19|19;drill-run|drill-peck|fu-21|21;acid|gunk-shot|fu-23|23;rollout|bulldoze|fu-27|27;toxic|sludge-wave|fu-29|29;horn-drill|earth-power|fu-32|32;gravity|moonblast|fu-35|35;will-o-wisp|extrasensory|fu-37|37;sing|hyper-voice|fu-39|39;leech-life|air-cutter|fu-41|41;petal-blizzard|petal-dance|fu-43|43;spore|energy-ball|fu-46|46;silver-wind|signal-beam|fu-48|48;mud-shot|fissure|fu-50|50;pay-day|play-rough|fu-52|52;soak|psyshock|fu-54|54;rage-fist|stomping-tantrum|fu-56|56;extreme-speed|flare-blitz|fu-58|58;bubble-beam|hypnosis|fu-60|60;psybeam|future-sight|fu-63|63;cross-chop|dynamic-punch|fu-66|66;slam|power-whip|fu-69|69;venoshock|whirlpool|fu-72|72;magnitude|rock-slide|fu-74|74;shadow-ball|hex|fu-92|92;bonemerang|shadow-bone|fu-104|104;air-slash|x-scissor|fu-123|123;waterfall|hyper-beam|fu-129|129;surf|blizzard|fu-131|131;swift|last-resort|fu-133|133;body-slam|giga-impact|fu-143|143;dragon-pulse|draco-meteor|fu-147|147;psychic|moonblast|fu-151|151;inferno|sacred-fire|fu-77|77;scald|expanding-force|fu-79|79;magnet-bomb|flash-cannon|fu-81|81;brave-bird|meteor-assault|fu-83|83;pluck|uproar|fu-84|84;aurora-beam|sheer-cold|fu-86|86;sludge|belch|fu-88|88;icicle-spear|icicle-crash|fu-90|90;stealth-rock|head-smash|fu-95|95;nightmare|dream-eater|fu-96|96;liquidation|crabhammer|fu-98|98;spark|discharge|fu-100|100;seed-bomb|wood-hammer|fu-102|102;rolling-kick|high-jump-kick|fu-106|106;ice-punch|focus-punch|fu-107|107;wring-out|heavy-slam|fu-108|108;smog|explosion|fu-109|109;high-horsepower|rock-wrecker|fu-111|111;egg-bomb|boomburst|fu-113|113;giga-drain|solar-blade|fu-114|114;mega-punch|mega-kick|fu-115|115;octazooka|hydro-cannon|fu-116|116;smart-strike|fishious-rend|fu-118|118;water-shuriken|photon-geyser|fu-120|120;barrier|misty-explosion|fu-122|122;lovely-kiss|frost-breath|fu-124|124;thunder-cage|bolt-strike|fu-125|125;lava-plume|eruption|fu-126|126;vital-throw|superpower|fu-127|127;raging-bull|headlong-rush|fu-128|128;transform|mimic|fu-132|132;fusion-bolt|techno-blast|fu-137|137;water-spout|meteor-beam|fu-138|138;sacred-sword|razor-shell|fu-140|140;thunder-fang|dragon-ascent|fu-142|142;bleakwind-storm|glaciate|fu-144|144;wildbolt-storm|electro-shot|fu-145|145;searing-shot|overheat|fu-146|146;psystrike|psycho-boost|fu-150|150";
  // 配方招式 id → key（升级卡 newMove 上只给数字 id，没有 key）
  const FUSION_MOVE_IDS = "75|razor-leaf;76|solar-beam;83|fire-spin;53|flamethrower;229|rapid-spin;56|hydro-pump;486|electro-ball;87|thunder;81|string-shot;405|bug-buzz;40|poison-sting;398|poison-jab;17|wing-attack;542|hurricane;158|hyper-fang;162|super-fang;529|drill-run;65|drill-peck;51|acid;441|gunk-shot;205|rollout;523|bulldoze;92|toxic;482|sludge-wave;32|horn-drill;414|earth-power;356|gravity;585|moonblast;261|will-o-wisp;326|extrasensory;47|sing;304|hyper-voice;141|leech-life;314|air-cutter;572|petal-blizzard;80|petal-dance;147|spore;412|energy-ball;318|silver-wind;324|signal-beam;341|mud-shot;90|fissure;6|pay-day;583|play-rough;487|soak;473|psyshock;889|rage-fist;707|stomping-tantrum;245|extreme-speed;394|flare-blitz;61|bubble-beam;95|hypnosis;60|psybeam;248|future-sight;238|cross-chop;223|dynamic-punch;21|slam;438|power-whip;474|venoshock;250|whirlpool;222|magnitude;157|rock-slide;247|shadow-ball;506|hex;155|bonemerang;708|shadow-bone;403|air-slash;404|x-scissor;127|waterfall;63|hyper-beam;57|surf;59|blizzard;129|swift;387|last-resort;34|body-slam;416|giga-impact;406|dragon-pulse;434|draco-meteor;94|psychic;517|inferno;221|sacred-fire;503|scald;797|expanding-force;443|magnet-bomb;430|flash-cannon;413|brave-bird;794|meteor-assault;365|pluck;253|uproar;62|aurora-beam;329|sheer-cold;124|sludge;562|belch;333|icicle-spear;556|icicle-crash;446|stealth-rock;457|head-smash;171|nightmare;138|dream-eater;710|liquidation;152|crabhammer;209|spark;435|discharge;402|seed-bomb;452|wood-hammer;27|rolling-kick;136|high-jump-kick;8|ice-punch;264|focus-punch;378|wring-out;484|heavy-slam;123|smog;153|explosion;667|high-horsepower;439|rock-wrecker;121|egg-bomb;586|boomburst;202|giga-drain;669|solar-blade;5|mega-punch;25|mega-kick;190|octazooka;308|hydro-cannon;684|smart-strike;755|fishious-rend;594|water-shuriken;722|photon-geyser;112|barrier;802|misty-explosion;142|lovely-kiss;524|frost-breath;819|thunder-cage;550|bolt-strike;436|lava-plume;284|eruption;233|vital-throw;276|superpower;873|raging-bull;838|headlong-rush;144|transform;102|mimic;559|fusion-bolt;546|techno-blast;323|water-spout;800|meteor-beam;533|sacred-sword;534|razor-shell;422|thunder-fang;620|dragon-ascent;846|bleakwind-storm;549|glaciate;847|wildbolt-storm;905|electro-shot;545|searing-shot;315|overheat;540|psystrike;354|psycho-boost";
  let midIdx = null;
  function moveKeyById(id) {
    if (id == null) return null;
    if (!midIdx) {
      midIdx = new Map();
      for (const row of FUSION_MOVE_IDS.split(";")) {
        if (!row) continue;
        const bar = row.indexOf("|");
        if (bar < 0) continue;
        midIdx.set(Number(row.slice(0, bar)), row.slice(bar + 1));
      }
    }
    return midIdx.get(Number(id)) ?? null;
  }
  let fpairIdx = null;
  function fusionPairIndex() {
    if (fpairIdx) return fpairIdx;
    const byMove = new Map();   // moveKey -> [{a,b,key}]
    for (const row of FUSION_PAIRS_RAW.split(";")) {
      if (!row) continue;
      const [a, b, key, member] = row.split("|");
      if (!a || !b) continue;
      const rec = { a, b, key, member: Number(member) || 0 };
      for (const mk of [a, b]) {
        if (!byMove.has(mk)) byMove.set(mk, []);
        byMove.get(mk).push(rec);
      }
    }
    fpairIdx = byMove;
    return fpairIdx;
  }
  // 某招式 key 参与的所有融合配方
  function pairsForMove(moveKey) {
    if (!moveKey) return [];
    return fusionPairIndex().get(moveKey) || [];
  }
  // 玩家当前招式里，已经"凑齐"的融合对（两边都持有）
  function fusionCompleted(run) {
    const moves = run?.player?.moves;
    if (!Array.isArray(moves)) return [];
    const held = new Set(moves.filter(Boolean).map(m => m.def?.key).filter(Boolean));
    const out = [];
    const seen = new Set();
    for (const mk of held) {
      for (const rec of pairsForMove(mk)) {
        if (seen.has(rec.key)) continue;
        if (held.has(rec.a) && held.has(rec.b)) { seen.add(rec.key); out.push(rec); }
      }
    }
    return out;
  }

  const STAT_W = {
    damage: 1.0, area: 0.85, attackSpeed: 0.85, maxHp: 0.7, luck: 0.6,
    moveSpeed: 0.5, pickup: 0.35, jumpHeight: 0.2, regen: 0.55,
  };
  // 招式是否还能继续升级（满级就没必要再选它的强化卡）
  function moveCanUp(mv) {
    if (!mv) return false;
    const lv = mv.level ?? 0;
    const max = mv.maxLevel ?? mv.def?.maxLevel ?? MOVE_MAX_LV;
    return lv < max;
  }
  // 融合条件：正辉的机器要“两个满级招式”。只要攒够 2 个满级就能融合，
  // 不要求所有招式都满级（学了新招式后等级回落，否则会永远等不到融合）
  function skillsCanFuse(run) {
    const moves = run?.player?.moves;
    if (!Array.isArray(moves)) return false;
    // 有现成配方对 → 只要这对都满级就能融
    for (const rec of fusionCompleted(run)) {
      const mA = moves.find(m => m && m.def?.key === rec.a);
      const mB = moves.find(m => m && m.def?.key === rec.b);
      if (mA && mB && !moveCanUp(mA) && !moveCanUp(mB)) return true;
    }
    // 没有配方对时退回旧口径：两个满级招式（reaction/同属性/glitch 也能源生配方）
    let n = 0;
    for (const mv of moves) if (mv && !moveCanUp(mv)) n++;
    return n >= 2;
  }
  function skillsAllMaxed(run) {
    const moves = run?.player?.moves;
    if (!Array.isArray(moves) || !moves.length) return false;
    return moves.every(mv => !moveCanUp(mv));
  }
  // 取一个 offer 上的招式 key（不同版本字段名不一致，逐个兜）
  // 升级卡上的字段（实测自 offerCard）：
  //   newMove → o.id 是数字招式 id（走 O_(o.id) 取定义）
  //   upMove  → o.slot 是招式槽位索引
  // 升级卡实测字段（已在游戏里逐张核对）：
  //   newMove → { kind, id, rarity, key }   key = "m" + 招式id，不是招式 key
  //   upMove  → { kind, slot, rarity, ups, key }   key 同样是 "m" + 招式id
  //   newVit  → { kind, vit, rarity, key }  key = 词条 key（vx-× / v×-×）
  // 所以招式 key 只能由 id → 配方映射表反查，或从 slot 读当前招式。
  function moveIdFromOffer(o) {
    if (typeof o.id === "number") return o.id;
    if (typeof o.key === "string") {
      const m = /^m(d+)$/.exec(o.key);
      if (m) return Number(m[1]);
    }
    return null;
  }
  function offerMoveKey(o, run) {
    if (!o) return null;
    if (o.kind === "upMove") {
      const mv = run?.player?.moves?.[o.slot];
      if (mv?.def?.key) return mv.def.key;
    }
    if (o.kind !== "newMove" && o.kind !== "upMove") return null;
    const id = moveIdFromOffer(o);
    return id == null ? null : moveKeyById(id);
  }
  // 融合亲和度：这个招式能不能和我手里已有的招式凑成配方
  // 融合亲和度分三档：
  //   ① 手里已有搭档 → 最高优先级（能立刻成对去融合）
  //   ② 属于某个配方但还没搭档 → 中等加成（先囤起来，下次刷到就成对）
  //   ③ 不在任何配方里 → 0
  function fusionAffinity(run, moveKey) {
    if (!moveKey) return 0;
    const moves = run?.player?.moves;
    if (!Array.isArray(moves)) return 0;
    const held = new Set(moves.filter(Boolean).map(m => m.def?.key).filter(Boolean));
    if (held.has(moveKey)) return 0;
    const recs = pairsForMove(moveKey);
    if (!recs.length) return 0;
    let best = 0;
    for (const rec of recs) {
      const partner = rec.a === moveKey ? rec.b : rec.a;
      if (!held.has(partner)) continue;
      const pm = moves.find(m => m && m.def?.key === partner);
      // 搭档越接近满级，越值得马上凑这一对
      const lvl = pm?.level ?? 0;
      const closeness = Math.min(1, lvl / MOVE_MAX_LV);
      best = Math.max(best, 130 + Math.round(130 * closeness));   // 130 ~ 260
    }
    // 没有现成搭档，但它是配方招式 → 潜力股，优先囤
    return best || 35;
  }
  function scoreOffer(run, o) {
    if (!o) return -1e9;
    const rar = (o.rarity ?? 0) * 8;
    const kind = o.kind;
    if (kind === "newMove") {
      // 新招式是主要伤害来源；但若它能和已有招式凑成融合，价值更高
      const aff = options.autoBill ? fusionAffinity(run, offerMoveKey(o, run)) : 0;
      return 120 + rar + aff;
    }
    if (kind === "upMove") {
      const mv = run?.player?.moves?.[o.slot];
      if (!moveCanUp(mv)) return -500 + rar;            // 已经满级，纯浪费
      // 正在冲击满级、且该招式在配方里 → 优先把它顶满，好去融合
      let bonus = 0;
      if (options.autoBill && mv?.def?.key) {
        const lv = mv.level ?? 0;
        const held = new Set((run?.player?.moves || []).filter(Boolean).map(m => m.def?.key));
        for (const rec of pairsForMove(mv.def.key)) {
          const partner = rec.a === mv.def.key ? rec.b : rec.a;
          if (!held.has(partner)) continue;
          // 已凑齐这一对，就差把它顶满 → 强烈优先
          bonus = Math.max(bonus, lv >= MOVE_MAX_LV - 2 ? 110 : 45);
        }
        if (!bonus && pairsForMove(mv.def.key).length) bonus = 20;   // 潜力股招式，顺手升
      }
      return 92 + rar + bonus;
    }
    const stat = o.vit ? (typeof o.vit === "string" ? o.vit : null) : null;
    const w = stat && STAT_W[stat] !== undefined ? STAT_W[stat] : 0.45;
    if (kind === "newVit") return 70 + rar + w * 20;    // 新词条比叠同类词条更值
    if (kind === "upVit") return 62 + rar + w * 16;
    return 60 + rar;
  }
  function bestOffer(run, offers) {
    let best = offers[0], bestScore = -1e9;
    const board = [];
    for (const o of offers) {
      // 真人会犹豫：加一点随机扰动，但不至于选明显更差的
      const raw = scoreOffer(run, o);
      const s = raw + (options.humanize ? randn() * 6 : 0);
      const k = offerMoveKey(o, run);
      const id = moveIdFromOffer(o);
      board.push({
        kind: o.kind,
        key: k ?? o.vit ?? (id != null ? "id" + id : o.slot != null ? "slot" + o.slot : "?"),
        fusion: !!(k && pairsForMove(k).length),
        score: Math.round(raw),
      });
      if (s > bestScore) { bestScore = s; best = o; }
    }
    auto.lastBoard = board;
    auto.lastPick = board[offers.indexOf(best)] ?? null;
    return best;
  }

  function patchLevelUp(ui) {
    if (!ui || typeof ui.showLevelUp !== "function" || ui.__pbAutoPatched) return false;
    const orig = ui.showLevelUp;
    ui.showLevelUp = function (e, offers, cb) {
      try {
        const run = e?.run ?? globalThis.__RUN ?? hooked?.run;
        const autoOn = options.autoLevel;
        if (autoOn && Array.isArray(offers) && offers.length) {
          const pick = options.smartPick ? bestOffer(run, offers) : offers[0];
          if (pick) {
            const delay = options.humanize ? rnd(options.pickMin, options.pickMax) : 0;
            // 挂起，交给看门狗统一触发（不在这里 setTimeout，避免异常被吞）
            pendingPick = { cb, pick, offers, at: Date.now(), due: Date.now() + delay, tries: 0 };
            auto.picks++;
            return;
          }
        }
      } catch (err) { lastError = "选卡评分: " + err.message; }
      return orig.call(this, e, offers, cb);
    };
    ui.__pbAutoPatched = true;
    auto.uiPatched = true;
    return true;
  }

  // ===== 祝福祭坛：走的是 ui.showBlessing(run, title, offers, cb, help)，不是 showLevelUp =====
  // offerBlessing 内部会连续弹 n 次（每次选完用剩余再弹），所以每次都接管即可自动连选
  function scoreBlessing(o) {
    if (!o) return -1e9;
    let s = (o.rarity ?? 0) * 10;
    const mods = Array.isArray(o.mods) ? o.mods : [];
    for (const m of mods) {
      const w = STAT_W[m.stat] ?? 0.4;
      // 相对增益（mul）与绝对增益（add）都折算成量级
      const mag = Math.abs((m.mul ?? 1) - 1) + Math.abs(m.add ?? 0) * 0.02;
      s += w * (12 + mag * 60);
    }
    return s;
  }
  function bestBlessing(offers) {
    let best = offers[0], bs = -1e9;
    for (const o of offers) {
      const s = scoreBlessing(o) + (options.humanize ? randn() * 5 : 0);
      if (s > bs) { bs = s; best = o; }
    }
    return best;
  }
  function patchBlessing(ui) {
    if (!ui || typeof ui.showBlessing !== "function" || ui.__pbBlessPatched) return false;
    const orig = ui.showBlessing;
    ui.showBlessing = function (e, title, offers, cb, help) {
      try {
        if ((options.autoBless || options.autoSnorlax) && Array.isArray(offers) && offers.length) {
          const pick = options.smartPick ? bestBlessing(offers) : offers[0];
          if (pick) {
            const delay = options.humanize ? rnd(options.pickMin, options.pickMax) : 0;
            pendingPick = { type: "bless", cb, pick, offers, at: Date.now(), due: Date.now() + delay, tries: 0 };
            auto.blessPicks = (auto.blessPicks || 0) + 1;
            return;
          }
        }
      } catch (err) { lastError = "祝福评分: " + err.message; }
      return orig.call(this, e, title, offers, cb, help);
    };
    ui.__pbBlessPatched = true;
    auto.blessPatched = true;
    return true;
  }

  // ===== 宝箱/道具奖励：第三套弹窗 =====
  // showItemChoice(run, items[], cb) —— cb(itemId) 拿走，cb(null) 卖掉
  // showItem(run, item, cb)          —— cb(true) 拿走，cb(false) 卖掉
  // 这两套都不走 showLevelUp / showBlessing，必须单独接管，否则对局卡在 modal
  const RARITY_W = { "普通": 0, "少见": 10, "稀有": 24, "史诗": 42, "传说": 65 };
  function scoreItemByDOM(idx) {
    try {
      const cards = [...document.querySelectorAll("button.card")];
      const c = cards[idx];
      if (!c) return 0;
      const rar = (c.querySelector("span.rar")?.innerText || "").trim();
      let s = RARITY_W[rar] ?? 8;
      const txt = c.innerText || "";
      if (/伤害|攻击|招式|范围|暴击/.test(txt)) s += 14;
      if (/生命|再生|治疗|护盾|闪避/.test(txt)) s += 9;
      if (/宝可币|金币|经验|XP/.test(txt)) s += 7;
      if (/移速|跳跃|拾取/.test(txt)) s += 4;
      return s;
    } catch { return 0; }
  }
  function bestItemIndex(items) {
    let best = 0, bs = -1e9;
    for (let i = 0; i < items.length; i++) {
      const s = scoreItemByDOM(i) + (options.humanize ? randn() * 3 : 0);
      if (s > bs) { bs = s; best = i; }
    }
    return best;
  }
  function patchItemChoice(ui) {
    if (!ui || ui.__pbItemPatched) return false;
    // —— 多选一 ——（稀有度要等卡片进 DOM 才读得到，所以延迟到看门狗里决定）
    if (typeof ui.showItemChoice === "function") {
      const orig = ui.showItemChoice;
      ui.showItemChoice = function (e, items, cb) {
        try {
          if (options.autoLoot && Array.isArray(items) && items.length) {
            pendingPick = {
              type: "item", cb, offers: items, pick: null,
              at: Date.now(), due: Date.now() + (options.humanize ? rnd(options.pickMin, options.pickMax) : 120),
              tries: 0,
            };
            auto.items = (auto.items || 0) + 1;
            return;
          }
        } catch (err) { lastError = "道具选择: " + err.message; }
        return orig.call(this, e, items, cb);
      };
    }
    // —— 单个道具：直接拿，不卖 ——
    if (typeof ui.showItem === "function") {
      const origOne = ui.showItem;
      ui.showItem = function (e, item, cb) {
        try {
          if (options.autoLoot) {
            pendingPick = {
              type: "item1", cb, offers: [item], pick: true,
              at: Date.now(), due: Date.now() + (options.humanize ? rnd(options.pickMin, options.pickMax) : 120),
              tries: 0,
            };
            auto.items = (auto.items || 0) + 1;
            return;
          }
        } catch (err) { lastError = "道具拾取: " + err.message; }
        return origOne.call(this, e, item, cb);
      };
    }
    ui.__pbItemPatched = true;
    auto.itemPatched = true;
    return true;
  }

  // ===== 百变怪：第五套弹窗 showDitto(run, cb) =====
  // 游戏侧：run.$omzz3y(cb) → state='modal' → ui.showDitto(run, t => {
  //   t && (player 加一件该道具, cb() 把 used 置真, toast, cry); resume() })
  // 卡片是 button.card.mini，满级的带 span.kind = "Máx." 且点击只会 deny。
  // 回调参数是道具 key，我们拿不到 key 列表，所以直接点卡片（onclick 走游戏自己的 t(key)）。
  function patchDitto(ui) {
    if (!ui || typeof ui.showDitto !== "function" || ui.__pbDittoPatched) return false;
    const orig = ui.showDitto;
    ui.showDitto = function (e, cb) {
      try {
        if (options.autoDitto) {
          pendingPick = {
            type: "ditto", cb, offers: null, pick: null, it: currentIt,
            at: Date.now(), due: Date.now() + (options.humanize ? rnd(options.pickMin, options.pickMax) : 150),
            tries: 0,
          };
          return;
        }
      } catch (err) { lastError = "百变怪: " + err.message; }
      return orig.call(this, e, cb);
    };
    ui.__pbDittoPatched = true;
    auto.dittoPatched = true;
    return true;
  }

  // ===== 正辉的机器：第四套弹窗 showFusion(run, options[], cb) =====
  // cb(index) 选择，cb(null) 放弃。只有 option.ready 为真才真融合。
  function patchFusion(ui) {
    if (!ui || typeof ui.showFusion !== "function" || ui.__pbFusionPatched) return false;
    const orig = ui.showFusion;
    ui.showFusion = function (run, opts, cb) {
      try {
        if (options.autoBill && Array.isArray(opts) && opts.length) {
          const idx = opts.findIndex(o => o && o.ready);
          if (idx >= 0) {
            pendingPick = {
              type: "fusion", cb, pick: idx, offers: opts,
              at: Date.now(), due: Date.now() + (options.humanize ? rnd(options.pickMin, options.pickMax) : 200),
              tries: 0,
            };
            auto.fusions = (auto.fusions || 0) + 1;
            return;
          }
          // 全是 locked（招式没到满级）→ 直接放弃，别把对局卡在弹窗里
          try { cb(null); } catch {}
          auto.fusionSkip = (auto.fusionSkip || 0) + 1;
          return;
        }
      } catch (err) { lastError = "融合: " + err.message; }
      return orig.call(this, run, opts, cb);
    };
    ui.__pbFusionPatched = true;
    auto.fusionPatched = true;
    return true;
  }

  // ===== 融合弹窗兜底 =====
  // 实测：run.xS() 会先把 state 设成 'modal'，再调 ui.showFusion —— 但运行时
  // ui.showFusion 并不存在（抛出被吞），于是 state 永远停在 modal → 整局卡死。
  // 卡片是别处直接拼出来的 DOM，所以这里直接用 DOM 兜底：
  //   有可融合的卡 → 点它；全是 locked 或没有卡 → 点“以后再说”退出。
  function resolveFusionModal(run) {
    if (!run || run.state !== "modal") return false;
    if (!options.autoBill) return false;
    let card = null, esc = null;
    try {
      const all = [...document.querySelectorAll(".card.fusion")];
      card = all.find(c => !c.classList.contains("locked"));
      if (!card) {
        esc = [...document.querySelectorAll(".btn.ghost, .btn")]
          .find(b => /以后再说|Más tarde|Luego|Ahora no|Esc/i.test(b.innerText || ""));
      }
    } catch { return false; }
    const now = Date.now();
    if (now - (auto.fusionAt || 0) < 700) return true;
    auto.fusionAt = now;
    if (card) {
      try { card.click(); auto.fusionPicks = (auto.fusionPicks || 0) + 1; return true; }
      catch { /* 落到下面走退出 */ }
    }
    if (esc) {
      try { esc.click(); auto.fusionSkip = (auto.fusionSkip || 0) + 1; return true; }
      catch {}
    }
    // 最后手段：直接复位 state，避免整局卡死（只在确实点了没反应时用）
    if ((auto.fusionFail || 0) > 6) {
      try { run.state = "play"; auto.fusionFail = 0; } catch {}
    } else {
      auto.fusionFail = (auto.fusionFail || 0) + 1;
    }
    return true;
  }

  // 看门狗：到点就调用挂起的 cb；失败则退化为直接点卡（onclick 是原生处理器）
  function resolvePendingPick(run) {
    if (!pendingPick) return;
    const now = Date.now();
    if (now < pendingPick.due) return;
    const p = pendingPick;

    // —— 百变怪：卡片已在 DOM，挑一张"还能加"的最有价值的点掉 ——
    // 卡片是 button.card.mini，满级的那张带 span.kind="Máx." 且点击只会 deny。
    if (p.type === "ditto") {
      let cards = [];
      try { cards = [...document.querySelectorAll("button.card.mini")]; } catch {}
      let best = -1, bestScore = -1e9;
      for (let i = 0; i < cards.length; i++) {
        const c = cards[i];
        const maxed = /Máx\.|Max\./i.test(c.querySelector("span.kind")?.innerText || "");
        if (maxed) continue;
        const txt = (c.innerText || "") + " " + (c.querySelector("h3")?.innerText || "");
        let s = 8;
        if (/伤害|攻击|招式|范围|暴击|daño|ataque/i.test(txt)) s += 14;
        if (/生命|再生|治疗|护盾|闪避|PS|vida|salud/i.test(txt)) s += 9;
        if (/宝可币|金币|经验|XP|oro/i.test(txt)) s += 7;
        if (/移速|跳跃|拾取|velocidad/i.test(txt)) s += 4;
        if (options.humanize) s += randn() * 3;
        if (s > bestScore) { bestScore = s; best = i; }
      }
      if (best >= 0) {
        try {
          cards[best].click();
          auto.dittoPicks = (auto.dittoPicks || 0) + 1;
          pendingPick = null; lastError = "";
          return;
        } catch (err) { lastError = "百变怪点击: " + err.message; }
      }
      // 没有可复制的卡片：走 cb(null) 让游戏 resume，并标记跳过，别原地反复触发
      try { p.cb(null); } catch {}
      if (p.it) p.it.__pbDone = true;
      auto.dittoSkips = (auto.dittoSkips || 0) + 1;
      pendingPick = null;
      return;
    }

    // —— 多选一道具：此刻卡片已在 DOM，按稀有度+词条挑最好的 ——
    if (p.type === "item") {
      const idx = bestItemIndex(p.offers);
      p.pick = p.offers[idx];
      try {
        p.cb(p.pick);
        auto.itemPicks = (auto.itemPicks || 0) + 1;
        pendingPick = null; lastError = ""; return;
      } catch (err) {
        p.tries++;
        try {
          const cards = [...document.querySelectorAll("button.card")];
          if (cards[idx]) { cards[idx].click(); auto.itemPicks = (auto.itemPicks || 0) + 1; pendingPick = null; return; }
        } catch {}
        if (p.tries > 4) { pendingPick = null; }
        return;
      }
    }

    // —— 单个道具：cb(true) = Coger ——
    if (p.type === "item1") {
      try {
        p.cb(true);
        auto.itemPicks = (auto.itemPicks || 0) + 1;
        pendingPick = null; lastError = ""; return;
      } catch (err) {
        p.tries++;
        try {
          const take = document.querySelector("button.btn.green.big");
          if (take) { take.click(); auto.itemPicks = (auto.itemPicks || 0) + 1; pendingPick = null; return; }
        } catch {}
        if (p.tries > 4) { pendingPick = null; }
        return;
      }
    }

    // —— 融合：cb(index) 或 cb(null) ——
    if (p.type === "fusion") {
      try {
        p.cb(p.pick);
        auto.fusionPicks = (auto.fusionPicks || 0) + 1;
        pendingPick = null; lastError = ""; return;
      } catch (err) {
        p.tries++;
        try {
          const card = document.querySelector("button.card, .card.fusion");
          if (card && card.click) { card.click(); auto.fusionPicks = (auto.fusionPicks || 0) + 1; pendingPick = null; return; }
          cb(null);
        } catch {}
        if (p.tries > 3) { try { p.cb(null); } catch {} pendingPick = null; }
        return;
      }
    }

    const { cb, pick } = p;
    // 卡片选择器：升级卡是 button.card.offer，祝福卡是 button.card
    const sel = p.type === "bless" ? "button.card" : "button.card.offer";
    try {
      cb(pick);
      pendingPick = null;
      lastError = "";
      return;
    } catch (err) {
      p.tries++;
      // 回调失败：改用 DOM 点击对应卡片（onclick 是原生处理器，合成点击能触发）
      try {
        const cards = [...document.querySelectorAll(sel)];
        const idx = p.offers.indexOf(pick);
        if (cards[idx]) { cards[idx].click(); pendingPick = null; return; }
      } catch {}
      if (p.tries > 4) {
        lastError = "选卡回调失败: " + err.message;
        // 最后兜底：随便点第一张，别让对局卡死
        auto.forcePicks = (auto.forcePicks || 0) + 1;
        try {
          const c = document.querySelector(sel);
          if (c) c.click();
        } catch {}
        pendingPick = null;
      }
    }
  }

  // ===== 跳跃补丁：让 input.hit('Space') 在我们要求时返回 true =====
  function patchJump(inp) {
    if (!inp || typeof inp.hit !== "function" || inp.__pbHitPatched) return false;
    const origHit = inp.hit.bind(inp);
    inp.hit = function (code) {
      if (code === "Space" && auto.wantJump) { auto.wantJump = false; return true; }
      return origHit(code);
    };
    inp.__pbHitPatched = true;
    return true;
  }

  function restore() {
    if (!hooked) return;
    const { player, descriptor, recompute, patchedRecompute, run, magnet, ui, origShowLevelUp } = hooked;
    if (hooked.locked) {
      const value = player.hp;
      Object.defineProperty(player, "hp", { ...descriptor, value });
    }
    if (player.recompute === patchedRecompute) {
      if (hooked.ownRecompute) Object.defineProperty(player, "recompute", hooked.ownRecompute);
      else delete player.recompute;
    }
    if (run.pickups && options.magnet) run.pickups.magnetAll = magnet;
    if (run.capture && hooked.savedCapture) Object.assign(run.capture, hooked.savedCapture);
    if (run.capture?.caught === hooked.patchedCaught) {
      if (hooked.ownCaught) Object.defineProperty(run.capture, "caught", hooked.ownCaught);
      else delete run.capture.caught;
    }
    // 复位升级补丁
    try {
      if (ui && ui.__pbAutoPatched && origShowLevelUp) { ui.showLevelUp = origShowLevelUp; delete ui.__pbAutoPatched; }
    } catch {}
    // 复位跳跃补丁
    try {
      const inp = run?.input;
      if (inp && inp.__pbHitPatched) { delete inp.hit; delete inp.__pbHitPatched; }
    } catch {}
    hooked = null;
    try { recompute.call(player); } catch {}
  }

  function setHealth() {
    const h = hooked, p = h.player, o = effective();
    if (o.god && !h.locked && !p.dead) {
      Object.defineProperty(p, "hp", {
        configurable: true, enumerable: h.descriptor.enumerable,
        get() {
          if (options.softGod) {
            if (this.maxHp > 0 && this.__hpRaw !== undefined && this.__hpRaw <= this.maxHp * 0.35) {
              this.__hpRaw = this.maxHp * 0.75;
            }
            return this.__hpRaw !== undefined ? this.__hpRaw : this.maxHp;
          }
          return this.maxHp;
        },
        set(v) { this.__hpRaw = v; },
      });
      h.locked = true;
    } else if (!o.god && h.locked) {
      const value = p.hp;
      Object.defineProperty(p, "hp", { ...h.descriptor, value });
      h.locked = false;
    }
  }

  // 所有弹窗接管集中一处，便于在 attach 之后反复重试。
  // 原因：attach() 对同一局只会执行一次，如果那一刻游戏还没挂上某个 UI 方法
  // （或 ui 对象被重建），补丁就会永久缺失 —— 表现为弹窗卡住、自动化不生效。
  function patchAllUI(ui) {
    if (!ui) return false;
    let any = false;
    try { any = patchLevelUp(ui) || any; } catch {}
    try { any = patchBlessing(ui) || any; } catch {}
    try { any = patchItemChoice(ui) || any; } catch {}
    try { any = patchDitto(ui) || any; } catch {}
    try { any = patchFusion(ui) || any; } catch {}
    return any;
  }

  function attach() {
    const run = usable();
    ranked = isRanked(run);
    if (hooked?.run === run) return;
    restore();
    if (!run) return;
    const player = run.player;
    const descriptor = Object.getOwnPropertyDescriptor(player, "hp");
    if (!descriptor?.configurable || !("value" in descriptor) ||
        typeof player.recompute !== "function" || typeof player.hurt !== "function") {
      throw Error("游戏版本不兼容：玩家字段变化");
    }
    const recompute = player.recompute;
    const patchedRecompute = function (...args) {
      const result = Reflect.apply(recompute, this, args);
      const o = effective();
      const d = o.safeMode ? jitter(o.damage) : o.damage;
      const a = o.safeMode ? jitter(o.area) : o.area;
      const as = o.safeMode ? jitter(o.attackSpeed) : o.attackSpeed;
      const ms = o.safeMode ? jitter(o.moveSpeed) : o.moveSpeed;
      this.stats.damage *= d;
      this.stats.area *= a;
      this.stats.attackSpeed *= as;
      this.stats.moveSpeed *= ms;
      this.stats.pickupRange = Math.max(this.stats.pickupRange, o.pickup);
      return result;
    };
    const ui = run.ui;
    hooked = {
      run, player, descriptor, recompute, patchedRecompute,
      ownRecompute: Object.getOwnPropertyDescriptor(player, "recompute"),
      locked: false, magnet: run.pickups?.magnetAll ?? 0, savedCapture: null,
      ownCaught: run.capture ? Object.getOwnPropertyDescriptor(run.capture, "caught") : null,
      ui, origShowLevelUp: ui?.showLevelUp,
    };
    if (typeof run.capture?.caught === "function") {
      const originalCaught = run.capture.caught;
      hooked.patchedCaught = function (...args) {
        const result = Reflect.apply(originalCaught, this, args);
        if (queue.active && queue.run === run && queue.current?.index === this.index &&
            queue.current.id === this.species) queue.current.caught = true;
        return result;
      };
      run.capture.caught = hooked.patchedCaught;
    }
    player.recompute = patchedRecompute;
    patchAllUI(ui);
    patchJump(run.input);
    setHealth();
    player.recompute();
  }

  // ===== 交互物：宝箱 / 商店 / 守护者 =====
  // 只读 kind/x/y/z/r/used/cost —— group 是大坨 THREE.js JSON，绝不要碰
  const CHEST_KINDS = ["chest", "freechest", "cursedchest", "cage"];
  const SHOP_KINDS = ["meowth"];
  const BLESS_KINDS = ["altar"];              // 祝福祭坛
  const RES_KINDS = ["rock", "berry"];        // 黄金岩石 / 树果
  const CHALLENGE_KINDS = ["challenge"];      // 挑战祭坛
  const PORTAL_KINDS = ["portal"];            // 挑战完成后的传送门
  const SHRINE_KINDS = ["shrine"];            // 圣地中心神龛（触碰即召唤守护者）
  const BILL_KINDS = ["bill"];                // 正辉的机器（技能满级后融合）
  const DITTO_KINDS = ["ditto"];              // 百变怪：复制一个道具
  const SNORLAX_KINDS = ["snorlax"];          // 卡比兽：85% 免费祝福，否则金币
  // 百变怪只能复制"还没满级"的道具；全满时游戏只弹一句提示就 return
  function hasCopiableItem(run) {
    try {
      const items = run?.player?.items;
      if (!items || !items.size) return false;
      const canAdd = run.player.$k0pr1y;
      if (typeof canAdd !== "function") return true;
      for (const key of items.keys()) {
        try { if (canAdd.call(run.player, key)) return true; } catch {}
      }
      return false;
    } catch { return false; }
  }
  const challengeLevelForStage = (stage) => {
    const index = Math.max(1, Math.floor(Number(stage) || 1));
    return index === 1 ? 25 : index === 2 ? 40 : 60;
  };
  // 守护者与挑战祭坛共用同一套区域等级门槛（区域1/2/3 = 25/40/60 级）
  const guardianLevelForStage = challengeLevelForStage;
  let goal = null, goalAt = 0, goalEvalAt = 0;
  let chargingAltar = null;   // 正在充能的祝福祭坛（充完才计一次 bless）
  let currentIt = null;       // 当前正在交互的交互物（供弹窗接管回指）
  const shopCooldowns = new Map();
  const sameIt = (a, b) => a && b && a.kind === b.kind &&
    Math.abs(a.x - b.x) < 0.5 && Math.abs(a.z - b.z) < 0.5;
  const shopKey = (run, it) => `${run.stage ?? 0}:${Math.round(it.x)}:${Math.round(it.z)}`;

  // 停靠距离：普通交互物走到 r+0.6 就能按；
  // 但祝福祭坛必须站进 r 之内才会充能（bundle: altarUpdate 里 t<e.r 才累加 charge），
  // 所以祭坛要走到更靠里的位置。
  const stopDist = (it) => BLESS_KINDS.includes(it?.kind)
    ? Math.max(1.5, (it.r ?? 4) * 0.7)
    : (it.r ?? 2) + 0.6;

  function listInteractables(run) {
    const li = run.interactables?.list;
    return Array.isArray(li) ? li : null;
  }

  // 选一个当前最该去的目标（距离优先，权重可调）
  // 关键：带滞回。锁定目标后不轻易更换，否则会在距离相近的宝箱间反复切换导致原地打转
  function pickGoal(run) {
    const li = listInteractables(run);
    if (!li || !li.length) { goal = null; return null; }
    if (!lootWanted() && !li.some((it) => it?.kind === "portal")) { goal = null; return null; }
    const px = run.player.pos.x, pz = run.player.pos.z;
    const now = Date.now();

    // 0) 圣地神龛最先：圣地(第四区域)只生成中心神龛，触碰才召唤守护者。
    //    必须排在传送门之前，否则会被"离开圣地"的传送门抢先带走。
    const shrineNow = li.find((it) => it && SHRINE_KINDS.includes(it.kind) && !it.used && !it.__pbDone);
    if (shrineNow && !run.bossSpawned) {
      let sOk = true;
      try {
        if (typeof run.terrain?.inBounds === "function") sOk = run.terrain.inBounds(shrineNow.x, shrineNow.z, 3);
      } catch { sOk = true; }
      if (sOk) { goal = shrineNow; goalAt = now; return goal; }
    }

    // 0.1) 传送门凌驾一切：一旦出现立刻放弃当前目标直奔，不等滞回过期
    //    （传送门是推进下一区域的唯一入口，晚去一秒就多刷一秒）
    const portalNow = li.find((it) => it && PORTAL_KINDS.includes(it.kind) && !it.__pbDone);
    if (portalNow) {
      let pOk = true;
      try {
        if (typeof run.terrain?.inBounds === "function") pOk = run.terrain.inBounds(portalNow.x, portalNow.z, 3);
      } catch { pOk = true; }
      if (pOk) { goal = portalNow; goalAt = now; return goal; }
    }

    // 1) 当前目标仍有效 → 继续锁定
    if (goal) {
      const gd = Math.hypot(goal.x - px, goal.z - pz);
      const portalGoal = PORTAL_KINDS.includes(goal.kind);
      const alive = (portalGoal ? !goal.__pbDone : (!goal.used && !goal.__pbDone)) &&
        li.some(x => sameIt(x, goal));
      const fresh = BLESS_KINDS.includes(goal.kind) ? true : now - goalAt < 25000;
      // 目标跑出地图也必须放弃，否则会一直顶着边界走不动
      let ok2 = false;
      try {
        ok2 = typeof run.terrain?.inBounds === "function"
          ? run.terrain.inBounds(goal.x, goal.z, 3)
          : true;
      } catch { ok2 = true; }
      // 区域硬目标（守护者/挑战祭坛/机器/祝福祭坛/免费球）不受战利品半径约束
      const hard = goal.kind === "boss" || SHRINE_KINDS.includes(goal.kind) || CHALLENGE_KINDS.includes(goal.kind) ||
        BILL_KINDS.includes(goal.kind) || BLESS_KINDS.includes(goal.kind) || goal.kind === "freechest" ||
        DITTO_KINDS.includes(goal.kind) || SNORLAX_KINDS.includes(goal.kind);
      if (alive && fresh && ok2 && (portalGoal || hard || gd <= options.lootRange * 1.3)) return goal;
      goal = null;
    }

    // 2) 没目标时，每 700ms 才重新评估一次
    if (now < goalEvalAt) return goal;
    goalEvalAt = now + 700;

    // 买不起的宝箱/笼子根本不该成为目标（否则会站在跟前干等）
    const mgr = run.interactables;
    const gold = run.gold ?? 0;
    let chestCost = 0, cageCost = 0;
    try { if (typeof mgr?.chestCost === "function") chestCost = mgr.chestCost(); } catch {}
    try { if (typeof mgr?.cageCost === "function") cageCost = mgr.cageCost(); } catch {}

    // 地图外的东西没必要追（会一路顶墙，被弹回来形成来回扫）
    const inB = (x, z) => {
      try {
        if (typeof run.terrain?.inBounds === "function") return run.terrain.inBounds(x, z, 3);
      } catch {}
      const half = (run.terrain?.play ?? 168) - 3;
      return Math.abs(x) < half && Math.abs(z) < half;
    };

    // 技能全满才会去碰正辉的机器（否则会把还没满的技能融合掉）
    const billOpen = options.autoBill && skillsCanFuse(run);

    // —— 硬优先：这几类不是"比距离"，而是"有条件就立刻去" ——
    // 0.4) 第四区域（圣地）中心的神龛：触碰即 spawnBoss，是圣地唯一的推进入口。
    //      地形在 sanctuary 模式下只生成这一个 shrine(0,0)，不去碰就永远打不到守护者。
    //      排在传送门之前，避免被"离开圣地"的传送门抢先带走。
    const shrine = li.find((it) => it && SHRINE_KINDS.includes(it.kind) &&
      !it.used && !it.__pbDone && inB(it.x, it.z));
    if (shrine && !run.bossSpawned) { goal = shrine; goalAt = now; return goal; }
    // 挑战完成后的传送门是推进对局的必经目标，不受战利品开关和半径限制。
    const portal = li.find((it) => it && PORTAL_KINDS.includes(it.kind) &&
      !it.__pbDone && inB(it.x, it.z));
    if (portal) { goal = portal; goalAt = now; return goal; }
    // 0.5) 守护者是本区域的收尾目标：等级达标后立刻去打，不参与距离比价。
    //      地形 populate() 把它生成在距中心 0.55~0.97×play 处（实测 141~250），
    //      按 d*pri 打分永远输给近处的宝箱/祭坛，导致一直打不到。
    if (options.autoBoss && (run.player.level ?? 0) >= guardianLevelForStage(run.stage)) {
      const boss = li.find(x => x && x.kind === "boss" && !x.used && !x.__pbDone && inB(x.x, x.z));
      if (boss) { goal = boss; goalAt = now; return goal; }
    }
    // 1) 技能全满 → 直奔正辉的机器（融合是唯一提升途径）
    if (billOpen) {
      const bill = li.find(x => x && x.kind === "bill" && !x.used && !x.__pbDone && inB(x.x, x.z));
      if (bill && Math.hypot(bill.x - px, bill.z - pz) <= options.lootRange * 2) {
        goal = bill; goalAt = now; return goal;
      }
    }
    // 2) 重伤（<45%）→ 先找最近的树果回血
    if (options.autoRes && (run.player.hp ?? 0) < (run.player.maxHp ?? 1) * 0.45) {
      let berry = null, bd = Infinity;
      for (const x of li) {
        if (!x || x.kind !== "berry" || x.used || x.__pbDone) continue;
        if (!inB(x.x, x.z)) continue;
        const d = Math.hypot(x.x - px, x.z - pz);
        if (d <= options.lootRange && d < bd) { bd = d; berry = x; }
      }
      if (berry) { goal = berry; goalAt = now; return goal; }
    }

    let best = null, bestScore = Infinity;
    for (const it of li) {
      if (!it || PORTAL_KINDS.includes(it.kind) || it.used || it.__pbDone) continue;
      const k = it.kind;
      // —— 白名单 + 开关 ——
      if (k === "boss") {
        // 守护者按区域等级门槛触发：区域1=25 级，区域2=40 级，区域3=60 级
        if (!options.autoBoss) continue;
        if ((run.player.level ?? 0) < guardianLevelForStage(run.stage)) continue;
      } else if (SHOP_KINDS.includes(k)) {
        if (!options.autoShop) continue;
      } else if (SHRINE_KINDS.includes(k)) {
        // 圣地神龛：无条件触碰（它本身就是守护者召唤入口）
        if (run.bossSpawned) continue;
      } else if (BLESS_KINDS.includes(k)) {
        if (!options.autoBless) continue;
        // 封印期（stageTime < seal，金祭坛前 90 秒）充能不累积，先别浪费时间
        if (it.data?.sealed) continue;
      } else if (RES_KINDS.includes(k)) {
        if (!options.autoRes) continue;
      } else if (CHALLENGE_KINDS.includes(k)) {
        if (!options.autoChallenge) continue;
        // 挑战祭坛会刷 8+3×区域 只怪的波次。没锁血时按区域等级门槛（25/40/60）
        // 保守跳过；开了锁血/软锁血就能硬吃这一波，直接接。
        if (!options.god && !options.softGod && (run.player.level ?? 0) < challengeLevelForStage(run.stage)) continue;
      } else if (DITTO_KINDS.includes(k)) {
        if (!options.autoDitto) continue;
        if (!hasCopiableItem(run)) continue;      // 没有可复制的道具，去了也只弹提示
      } else if (SNORLAX_KINDS.includes(k)) {
        if (!options.autoSnorlax) continue;
      } else if (BILL_KINDS.includes(k)) {
        if (!billOpen) continue;
      } else if (!CHEST_KINDS.includes(k)) {
        continue;
      }
      if (SHOP_KINDS.includes(k) && shopCooldowns.has(shopKey(run, it))) continue;
      if (k === "cursedchest" && !options.allowCursed) continue;
      // 付费宝箱/笼子：钱不够直接跳过
      if (k === "chest" && !it.data?.gift && gold < chestCost) continue;
      if (k === "cage" && gold < cageCost) continue;
      // 树果只在掉血时才值得绕路
      if (k === "berry" && (run.player.hp ?? 0) > (run.player.maxHp ?? 1) * 0.75) continue;
      if (!inB(it.x, it.z)) continue;                  // 界外目标不追
      const d = Math.hypot(it.x - px, it.z - pz);
      // 区域硬目标（守护者 / 挑战祭坛 / 正辉机器）由地形 populate() 生成在
      // 距中心 0.55~0.97×play 处，远超 lootRange。若按战利品半径过滤，
      // 守护者(实测 141) / 机器(实测 170) 永远不会被选为目标。
      // 祝福祭坛与免费精灵球同理：每局只随机生成 3 个左右，距离 14~150，
      // 用 lootRange(默认 42) 过滤等于永远够不到 —— 这就是"不会开祭坛/免费球"。
      const hardTarget = k === "boss" || SHRINE_KINDS.includes(k) || CHALLENGE_KINDS.includes(k) ||
        BILL_KINDS.includes(k) || BLESS_KINDS.includes(k) || k === "freechest" ||
        DITTO_KINDS.includes(k) || SNORLAX_KINDS.includes(k);
      if (!hardTarget && d > options.lootRange) continue;
      // 优先级：守护者/祝福祭坛 > 挑战祭坛 > 商店 > 机器 > 宝箱 > 岩石/树果
      // 技能全满时，融合是唯一的提升途径 → 优先级拉到最高
      const hurt = (run.player.hp ?? 0) < (run.player.maxHp ?? 1) * 0.55;
      const pri =
        (BILL_KINDS.includes(k) && billOpen) ? 0.3 :
        k === "boss" ? 0.5 :
        SNORLAX_KINDS.includes(k) ? 0.52 :
        (k === "berry" && hurt) ? 0.55 :
        BLESS_KINDS.includes(k) ? 0.6 :
        DITTO_KINDS.includes(k) ? 0.65 :
        CHALLENGE_KINDS.includes(k) ? 0.7 :
        SHOP_KINDS.includes(k) ? 0.8 :
        BILL_KINDS.includes(k) ? 0.85 :
        RES_KINDS.includes(k) ? 1.05 : 1;
      const score = d * pri;
      if (score < bestScore) { bestScore = score; best = it; }
    }
    if (best) { goal = best; goalAt = now; }
    return goal;
  }

  // 交互：靠近到 r 以内就触发
  // 真实入口是 run.interactables.interact(item)，内部按 kind 分派：
  //   chest → 扣 chestCost() 后 openChest；freechest → openChest(e,true)
  //   cursedchest → openChest + 诅咒 + 伏击；challenge → startChallenge
  function tryInteract(run, it) {
    if (!it) return false;
    const p = run.player;
    const mgr = run.interactables;
    const d = Math.hypot(it.x - p.pos.x, it.z - p.pos.z);
    if (d > (it.r ?? 2) + 0.8) return false;
    if (it.used && !["meowth", "hypno", "portal", "tower"].includes(it.kind)) return false;
    const now = Date.now();
    if (now - (auto.lastAct || 0) < 450) return false;

    // 花钱的宝箱：钱不够就别点，免得白挨 deny 音效
    if (it.kind === "chest" && !it.data?.gift) {
      try {
        const cost = typeof mgr?.chestCost === "function" ? mgr.chestCost() : 0;
        if (cost > 0 && (run.gold ?? 0) < cost) return false;
      } catch {}
    }
    // 诅咒宝箱不开（会加难度+伏击），除非显式允许
    if (it.kind === "cursedchest" && !options.allowCursed) return false;

    auto.lastAct = now;
    try {
      // 商店：喵喵要打开界面才能买
      if (SHOP_KINDS.includes(it.kind)) {
        it.__pbDone = true;
        shopCooldowns.set(shopKey(run, it), true);
        goal = null; goalAt = 0; goalEvalAt = Date.now() + 1200;
        auto.shops = (auto.shops || 0) + 1;
        if (typeof run.openShop === "function") run.openShop();
        else if (typeof mgr?.interact === "function") mgr.interact(it);
        else throw Error("找不到商店开启接口");
        autoShopBuy(run);
        setTimeout(() => {
          try { if (run.state === "modal") run.resume?.(); }
          catch (error) { lastError = "退出商店: " + error.message; }
        }, 400);
        return true;
      }
      if (typeof mgr?.interact === "function") {
        // ===== 祝福祭坛：不是"按一下"就开 =====
        // bundle 里 interactables.interact() 的 switch 根本没有 altar 分支；
        // 祭坛是站在半径 r 内持续充能（xE[tier].charge = 8/14/22/35 秒），
        // charge 到 1 才 altarDone() → offerBlessing → ui.showBlessing。
        // 之前这里调 interact() 什么都不发生，随后又把 __pbDone 打上，
        // 于是祭坛被永久跳过 —— 这就是"不会开祭坛"。
        // 现在：不调用 interact、不打 __pbDone，只把人钉在圈里等它充完。
        if (BLESS_KINDS.includes(it.kind)) {
          if (!it.used) {
            if (!it.__pbCharging) { it.__pbCharging = true; auto.blessStart = (auto.blessStart || 0) + 1; }
            chargingAltar = it;
            return true;
          }
          return false;
        }
        // 传送门特殊：游戏 enterPortal() 第一次被调用时，若附近还有没开的奖励，
        // 只弹一句「你还剩 N 个超级球，再按一次 E 仍然进入」然后 return，并不真正进入。
        // 所以绝不能标记 __pbDone，必须持续重试直到 run.stage 变化或门消失。
        if (PORTAL_KINDS.includes(it.kind)) {
          mgr.interact(it);
          auto.portals = (auto.portals || 0) + 1;
          goal = null; goalAt = 0; goalEvalAt = Date.now() + 600;  // 快速重试
          return true;
        }
        currentIt = it;                      // 供 showDitto / showBlessing 等弹窗接管回指
        mgr.interact(it);
        // 有些交互物（尤其祭坛）自己不 set used，会导致我们反复去点同一个。
        // 打个私有标记，pickGoal 里跳过，避免同一目标被连点几十次。
        it.__pbDone = true;
        goal = null; goalAt = 0; goalEvalAt = Date.now() + 1200;
        if (CHEST_KINDS.includes(it.kind)) auto.chests = (auto.chests || 0) + 1;
        else if (it.kind === "boss") auto.bosses = (auto.bosses || 0) + 1;
        else if (BLESS_KINDS.includes(it.kind)) auto.bless = (auto.bless || 0) + 1;
        else if (it.kind === "rock") auto.rocks = (auto.rocks || 0) + 1;
        else if (it.kind === "berry") auto.berries = (auto.berries || 0) + 1;
        else if (CHALLENGE_KINDS.includes(it.kind)) auto.challenges = (auto.challenges || 0) + 1;
        else if (BILL_KINDS.includes(it.kind)) auto.bills = (auto.bills || 0) + 1;
        else if (DITTO_KINDS.includes(it.kind)) auto.dittos = (auto.dittos || 0) + 1;
        else if (SNORLAX_KINDS.includes(it.kind)) auto.snorlax = (auto.snorlax || 0) + 1;
        return true;
      }
    } catch (error) { lastError = "交互: " + error.message; }
    return false;
  }

  // ===== 自动商店：走到喵喵 → 打开商店 → 买得起就买 =====
  let shopAt = 0;
  function autoShopBuy(run) {
    if (!options.autoShop) return 0;
    const now = Date.now();
    if (now - shopAt < 2500) return 0;
    const stock = run.shop?.stock;
    if (!Array.isArray(stock) || !stock.length) return 0;
    shopAt = now;
    let bought = 0;
    // live bundle 把买入混淆成 $src50y(stockEntry) → boolean；
    // 保留 buyShopItem 作为其它版本的兜底。
    const buy = typeof run.$src50y === "function" ? run.$src50y.bind(run)
      : typeof run.buyShopItem === "function" ? run.buyShopItem.bind(run) : null;
    if (!buy) { lastError = "找不到商店买入接口"; return 0; }
    // 优先买便宜的，先保证能买得起
    const cands = stock.filter(s => s && !s.sold && (run.gold ?? 0) >= s.price)
      .sort((a, b) => a.price - b.price);
    for (const s of cands) {
      try {
        if (buy(s)) { bought++; auto.buys = (auto.buys || 0) + 1; }
        else break;   // 买不动（背包满/钱不够）就别硬试了
      } catch (error) { lastError = "商店买入: " + error.message; break; }
    }
    return bought;
  }

  // ===== 只走路拾取（不跑图）=====
  // 面板上「自动开箱 / 领精灵球」「自动祝福祭坛」是独立开关，但过去所有
  // 目标选择都写在 autoMove() 里，而 autoMove 只在 autoRun 时被调用 ——
  // 于是没开自动跑图时角色原地不动，免费精灵球和祭坛永远不会被打开。
  // 这里提供一个不带风筝/磁铁/意图切换的纯走路版本。
  function lootWalk(run) {
    const inp = run.input, p = run.player;
    if (!inp || !p || p.dead || run.state !== "play") return false;
    const tgt = pickGoal(run);
    if (!tgt) {
      if (options.humanize) {
        human.sx += (0 - human.sx) * options.smooth;
        human.sy += (0 - human.sy) * options.smooth;
        inp.stickX = human.sx; inp.stickY = -human.sy;
      } else { inp.stickX = 0; inp.stickY = 0; }
      return false;
    }
    const dx = tgt.x - p.pos.x, dz = tgt.z - p.pos.z;
    const d = Math.hypot(dx, dz) || 1;
    if (d > stopDist(tgt)) {
      const tx = dx / d, tz = dz / d;
      if (options.humanize) {
        human.sx += (tx - human.sx) * options.smooth;
        human.sy += (tz - human.sy) * options.smooth;
        inp.stickX = human.sx; inp.stickY = -human.sy;
      } else { inp.stickX = tx; inp.stickY = -tz; }
      return true;
    }
    // 到点：交互 / 站圈充能
    tryInteract(run, tgt);
    inp.stickX = 0; inp.stickY = 0;
    return true;
  }

  // ===== 自动跑图：斥力场风筝 + 边界内缩 + 卡住自动跳/绕障 =====
  let lastJump = 0;
  function autoMove(run) {
    const p = run.player, en = run.enemies, inp = run.input;
    if (!p || !en || !inp || p.dead || run.state !== "play") return;
    const n = en.n ?? 0;
    let rx = 0, rz = 0, near = 0;
    // 斥力：每个近敌按 1/d 加权推开
    for (let i = 0; i < n; i++) {
      if (!en.alive?.[i]) continue;
      const dx = p.pos.x - en.x[i], dz = p.pos.z - en.z[i];
      const d2 = dx * dx + dz * dz;
      if (d2 > 144) continue;               // 只算 12 半径内
      const d = Math.sqrt(d2) || 0.001;
      rx += dx / (d * d); rz += dz / (d * d);
      if (d < options.kiteNear) near++;
    }
    // 地图是方形，有边界：terrain.play 本身就是半边长（实测 168 → 活动区 ±168）
    // 注意不要再除以 2，否则会把活动范围人为缩小一半
    const half = Math.max(20, (run.terrain?.play ?? 168) - 10);
    const overX = Math.abs(p.pos.x) - half;
    const overZ = Math.abs(p.pos.z) - half;
    let wx = 0, wz = 0;
    if (overX > 0) { wx = -Math.sign(p.pos.x) * (1 + overX); }
    if (overZ > 0) { wz = -Math.sign(p.pos.z) * (1 + overZ); }
    if (!overX || !overZ) {
      // 未贴边时轻微向心，避免走远
      const cx = -p.pos.x, cz = -p.pos.z, cd = Math.hypot(cx, cz) || 1;
      wx += (cx / cd) * 0.25; wz += (cz / cd) * 0.25;
    }
    const wCenter = near >= 3 ? 1.4 : 0.45;
    let ux = rx + wx * wCenter, uz = rz + wz * wCenter;

    // ===== 目标寻路：有宝箱/商店/boss 时，走过去 > 风筝 =====
    const tgt = pickGoal(run);
    if (tgt) {
      const gx = tgt.x - p.pos.x, gz = tgt.z - p.pos.z;
      const gd = Math.hypot(gx, gz) || 1;
      if (gd > stopDist(tgt)) {
        // 先归一化斥力，再混合（必须用旧值，不能边算边改）
        const rl = Math.hypot(rx, rz) || 1;
        const nxr = rx / rl, nzr = rz / rl;
        // 没被围时几乎纯追目标；被围才让斥力占一部分
        const w = near >= 3 ? 0.5 : near >= 1 ? 0.78 : 0.94;
        ux = (gx / gd) * w + nxr * (1 - w);
        uz = (gz / gd) * w + nzr * (1 - w);
      } else {
        tryInteract(run, tgt);
        if (BLESS_KINDS.includes(tgt.kind)) {
          // 祭坛：站定不动等充能，别让斥力把人推出圈外
          ux = 0; uz = 0;
        } else {
          ux = rx * 0.2; uz = rz * 0.2;   // 到点了就停一下，别乱走
        }
      }
    }

    // ===== 自动捕捉优先：野生精灵出现时走过去（canThrow 要求 9 米内）=====
    // 传送门/神龛是区域推进的关键，不能被捕捉打断。
    if (options.autoCapture) {
      const cf = run.capture;
      const ci = cf && (cf.state === "roaming" || cf.state === "weakened") && Number.isFinite(cf.index)
        ? cf.index : -1;
      const blocked = tgt && (PORTAL_KINDS.includes(tgt.kind) || SHRINE_KINDS.includes(tgt.kind));
      if (ci >= 0 && !blocked && en.x && Number.isFinite(en.x[ci]) && Number.isFinite(en.z[ci])) {
        const ex = en.x[ci], ez = en.z[ci];
        const ed = Math.hypot(ex - p.pos.x, ez - p.pos.z) || 1;
        if (ed > 5) {
          // 靠近到 5 米（canThrow 判定是 9，留余量避免边界抖动）
          const rl2 = Math.hypot(rx, rz) || 1;
          const w2 = near >= 3 ? 0.62 : 0.9;
          ux = ((ex - p.pos.x) / ed) * w2 + (rx / rl2) * (1 - w2);
          uz = ((ez - p.pos.z) / ed) * w2 + (rz / rl2) * (1 - w2);
        } else {
          ux = rx * 0.2; uz = rz * 0.2;
        }
      }
    }

    // ===== 拟人层 =====
    const now = Date.now();
    if (options.humanize) {
      // 1) 意图状态机：人类不会只做一件事，会在刷怪/绕圈/后退/发呆间切换
      if (now > human.intentUntil && !human.pendingIntent) {
        const roll = Math.random();
        const next = roll < 0.5 ? "kite" : roll < 0.72 ? "circle" : roll < 0.88 ? "rush" : "hold";
        // 反应延迟：不立刻执行，延迟 reaction 后才切
        human.pendingIntent = next;
        human.pendingAt = now + rnd(options.reaction * 0.7, options.reaction * 1.6);
        human.intentUntil = now + rnd(1800, 6200);
      }
      if (human.pendingIntent && now >= human.pendingAt) {
        human.intent = human.pendingIntent;
        human.pendingIntent = null;
        if (human.intent === "hold") human.holdUntil = now + rnd(280, 1100);
      }

      // 2) 按意图改方向
      const L0 = Math.hypot(ux, uz) || 1;
      if (human.intent === "circle") {
        // 绕圈：切线方向
        const tx = -uz / L0, tz = ux / L0;
        ux = tx * 1.0 + (ux / L0) * 0.25;
        uz = tz * 1.0 + (uz / L0) * 0.25;
      } else if (human.intent === "rush" && near === 0) {
        // 主动贴上去（真人也会抢怪），但强度打七折
        ux = -ux * 0.7; uz = -uz * 0.7;
      } else if (human.intent === "hold" && now < human.holdUntil) {
        // 发呆：停一下
        ux = 0; uz = 0;
      }

      // 3) 人为失误：偶发短暂走反 / 手滑
      if (now > human.mistakeUntil && Math.random() < options.mistakeRate / 25) {
        human.mistakeUntil = now + rnd(160, 460);
        human.mistakeDir = Math.random() < 0.5 ? 1 : -1;
        auto.mistakes = (auto.mistakes || 0) + 1;
      }
      if (now < human.mistakeUntil) {
        const ang = 2.2 * human.mistakeDir;
        const cs = Math.cos(ang), sn = Math.sin(ang);
        const tx = ux * cs - uz * sn, tz = ux * sn + uz * cs;
        ux = tx; uz = tz;
      }

      // 4) OU 噪声（手抖）：平滑随机游走，不是白噪声
      human.nx += -human.nx * 0.08 + randn() * options.noise * 0.35;
      human.ny += -human.ny * 0.08 + randn() * options.noise * 0.35;
      ux += human.nx; uz += human.ny;
    }

    // ===== 目标接管：有目标时必须走过去，不能被 circle/hold 意图或噪声带偏 =====
    if (tgt) {
      const gx2 = tgt.x - p.pos.x, gz2 = tgt.z - p.pos.z;
      const gd2 = Math.hypot(gx2, gz2) || 1;
      if (gd2 > stopDist(tgt)) {
        // 只保留很小的噪声扰动，方向以目标为准；祭坛要精确站位，不加抖动
        const jx = options.humanize && !BLESS_KINDS.includes(tgt.kind) ? human.nx * 0.25 : 0;
        const jz = options.humanize && !BLESS_KINDS.includes(tgt.kind) ? human.ny * 0.25 : 0;
        ux = gx2 / gd2 + jx;
        uz = gz2 / gd2 + jz;
        // 关键：目标接管会绕过边界钳制，这里必须把边界推力加回来，
        // 否则会一路顶墙 → 被物理弹回 → z 轴来回扫
        const wb = near >= 3 ? 1.4 : 0.6;
        ux += wx * wb; uz += wz * wb;
      } else {
        ux = 0; uz = 0;
      }
    }

    // 卡住检测：stuckT 上升说明撞到障碍/坡，直接起跳并侧向绕行
    if ((p.stuckT ?? 0) > 0.15) {
      const now = Date.now();
      if (now - lastJump > 550) {
        lastJump = now;
        // 直接改物理起跳（不依赖 input.hit，避免被其它消费者吃掉）
        try {
          if (p.grounded && !p.dead) {
            const jh = p.stats?.jumpHeight ?? 1;
            p.vel.y = 11 * Math.sqrt(jh);
            p.grounded = false;
            p.jumpsLeft = Math.floor(p.stats?.extraJumps ?? 0);
            p.squash = -0.5;
            auto.jumps = (auto.jumps || 0) + 1;
          }
        } catch {}
        auto.wantJump = true;          // 同时给 hit 补丁兜底
      }
      // 绕障：把期望方向侧旋（交替左右）
      const dir = (auto.jumps || 0) % 2 ? 1 : -1;
      const ang = 1.15 * dir;
      const cs = Math.cos(ang), sn = Math.sin(ang);
      const tx = ux * cs - uz * sn, tz = ux * sn + uz * cs;
      ux = tx; uz = tz;
    }

    const L = Math.hypot(ux, uz);
    if (L < 1e-4) {
      // 平滑收敛到 0，而不是瞬间松手
      if (options.humanize) {
        human.sx += (0 - human.sx) * options.smooth;
        human.sy += (0 - human.sy) * options.smooth;
        inp.stickX = human.sx; inp.stickY = -human.sy;   // stickY 取反：正 = 世界 -Z
      } else { inp.stickX = 0; inp.stickY = 0; }
      return;
    }
    const tx = ux / L, tz = uz / L;
    if (options.humanize) {
      // 5) 一阶低通：模拟手的加减速，不做瞬间满幅跳变
      human.sx += (tx - human.sx) * options.smooth;
      human.sy += (tz - human.sy) * options.smooth;
      // 幅度也随机化：真人不会一直推满
      const mag = 0.82 + Math.random() * 0.18;
      inp.stickX = human.sx * mag;
      inp.stickY = -human.sy * mag;                      // stickY 取反：正 = 世界 -Z
    } else {
      inp.stickX = tx;
      inp.stickY = -tz;                                  // stickY 取反：正 = 世界 -Z
    }
  }

  // ===== 自动捕捉接近：只把角色带到野生精灵身边，与 autoRun 解耦 =====
  // 游戏 canThrow() 要求「weakened 且距精灵 < 9」，所以只勾「自动捕捉」时
  // 也必须能主动走过去，否则永远投不出去。
  function captureApproach(run) {
    if (!options.autoCapture) return false;
    const cf = run.capture, en = run.enemies, inp = run.input, p = run.player;
    if (!cf || !en || !inp || !p || p.dead || run.state !== "play") return false;
    if (cf.state !== "roaming" && cf.state !== "weakened") return false;
    const i = Number.isFinite(cf.index) ? cf.index : -1;
    if (i < 0) return false;
    const ex = en.x?.[i], ez = en.z?.[i];
    if (!Number.isFinite(ex) || !Number.isFinite(ez)) return false;
    const dx = ex - p.pos.x, dz = ez - p.pos.z;
    const d = Math.hypot(dx, dz) || 1;
    if (d <= 5) {                       // 已进入可投球范围，停下等 captureStep 投球
      inp.stickX = 0; inp.stickY = 0;
      return true;
    }
    const tx = dx / d, tz = dz / d;
    if (options.humanize) {
      human.sx += (tx - human.sx) * options.smooth;
      human.sy += (tz - human.sy) * options.smooth;
      inp.stickX = human.sx; inp.stickY = -human.sy;   // stickY 取反：正 = 世界 -Z
    } else {
      inp.stickX = tx; inp.stickY = -tz;
    }
    return true;
  }

  // ===== 自动大招：随机间隔，像人在等 CD 好再按 =====
  function autoUlt(run) {
    if (!options.autoSkill || !run.input?.keys) return;
    const now = Date.now();
    if (!options.humanize) {
      if (now - auto.skillAt < 4000) return;
      auto.skillAt = now;
    } else {
      if (!human.ultNext) human.ultNext = now + rnd(options.ultMin, options.ultMax);
      if (now < human.ultNext) return;
      // 人类会拖一点，偶尔提前或延后
      human.ultNext = now + rnd(options.ultMin, options.ultMax);
      if (Math.random() < 0.12) { human.ultNext += rnd(600, 2200); return; } // 偶尔忘了按
    }
    try {
      if (typeof run.input.keys.add === "function") {
        run.input.keys.add("KeyR"); auto.moves++;
        // 按住时长也随机（80-220ms），不是精确 120
        const dur = options.humanize ? rnd(80, 220) : 120;
        setTimeout(() => { try { run.input.keys.delete("KeyR"); } catch {} }, dur);
      }
    } catch {}
  }

  // 元素是否真的可见可点。
  // 不能用 offsetParent 判断：游戏的全屏覆盖层用 position:fixed，此时 offsetParent
  // 恒为 null，会把所有按钮误判成隐藏（旧代码就因此一个按钮都点不到）。
  // 用函数声明（会提升），保证文件里更早定义的函数也能安全调用。
  function isShown(el) {
    try {
      if (!el || el.isConnected === false || el.disabled) return false;
      const rects = typeof el.getClientRects === "function" ? el.getClientRects() : null;
      if (rects && rects.length) return rects[0].width > 1 && rects[0].height > 1;
      if (typeof el.offsetWidth === "number" && typeof el.offsetHeight === "number") {
        return el.offsetWidth > 1 || el.offsetHeight > 1;
      }
      return true;   // 环境无布局信息（测试桩）时按可见处理
    } catch { return true; }
  }

  // ===== 自动领取任务：菜单里点“领取/Reclamar/Claim” =====
  function autoResumeAck() {
    const now = Date.now();
    if (now - (auto.resumeAckAt || 0) < 1500) return;
    const text = document.body?.innerText || "";
    if (!/我们找回了你的上一局|recuperamos.*partida|partida recuperada/i.test(text)) return;
    try {
      const buttons = [...document.querySelectorAll("button,[role=button]")].filter(isShown);
      const ack = buttons.find((button) => /^(知道了|Entendido|Got it|OK)$/i.test((button.innerText || "").trim()));
      if (ack) {
        auto.resumeAckAt = now;
        ack.click();
      }
    } catch {}
  }

  function autoContinuePaused(run) {
    if (!run || !["pause", "paused", "suspended"].includes(run.state)) return;
    const now = Date.now();
    if (now - (auto.continueAt || 0) < 1000) return;
    auto.continueAt = now;
    try {
      if (typeof run.resume === "function") {
        run.resume();
        return;
      }
      const buttons = [...document.querySelectorAll("button,[role=button]")]
        .filter(isShown);
      const resume = buttons.find((button) =>
        /^(继续|继续游戏|恢复游戏|continuar|resume|continue)$/i.test((button.innerText || "").trim()));
      resume?.click();
    } catch {}
  }

  // ===== 菜单领奖：成就(quests) + 每日/每周任务(tasks) =====
  // 游戏侧真入口（比点 DOM 稳得多）：
  //   meta.claimable()      -> 有几个成就可领（progress >= goal 且未领）
  //   meta.claimQuest(q)    -> 领一个成就，返回 true 表示发出去了
  //   meta.tasksReady()     -> 有几个任务奖励可领（会顺带刷新每日/每周）
  //   meta.claimTask(p, i)  -> p = "daily" | "weekly"，i = 0..3 槽位
  // 成就列表来自 meta 上的 quest 表；拿不到就退回 DOM 点「¡Reclamar!」。
  function metaRef() {
    try { return app?.meta ?? app?.profile ?? null; } catch { return null; }
  }
  function claimAllRewards() {
    const meta = metaRef();
    if (!meta) return 0;
    let claimed = 0;
    // 1) 成就
    try {
      if (typeof meta.claimable === "function" && typeof meta.claimQuest === "function") {
        for (let guard = 0; guard < 40 && meta.claimable() > 0; guard++) {
          // 找出第一个可领的成就对象
          let target = null;
          try {
            const list = meta.quests ?? meta.questList ?? [];
            target = list.find((q) => q && !meta.profile?.quests?.[q.id] &&
              (typeof meta.questProgress === "function" ? meta.questProgress(q) : 0) >= q.goal) ?? null;
          } catch {}
          if (!target) break;                       // 数量对但拿不到对象 -> 交给 DOM 兜底
          if (meta.claimQuest(target) === false) break;
          claimed++;
        }
      }
    } catch (err) { lastError = "领成就: " + err.message; }
    // 2) 每日 / 每周任务
    try {
      if (typeof meta.tasksReady === "function" && typeof meta.claimTask === "function") {
        for (const period of ["daily", "weekly"]) {
          for (let slot = 0; slot < 4; slot++) {
            try { if (meta.claimTask(period, slot)) claimed++; } catch {}
          }
        }
      }
    } catch (err) { lastError = "领任务: " + err.message; }
    if (claimed) {
      auto.claims = (auto.claims || 0) + claimed;
      auto.lastClaim = claimed;
      auto.claimAt2 = Date.now();
    }
    return claimed;
  }

  // 兜底：真 API 拿不到时，在当前页点「¡Reclamar!」类按钮
  function clickRewardsHere() {
    let n = 0;
    try {
      const btns = [...document.querySelectorAll("button,[role=button]")].filter(isShown);
      for (const b of btns) {
        const t = (b.innerText || "").trim();
        // 成就/任务的领取按钮文案：¡Reclamar! / Reclamar / Claim
        if (/^¿?¡?Reclamar!?$/i.test(t) || /^(Claim|领取|收下)$/i.test(t)) {
          b.click(); n++;
          if (n >= 8) break;
        }
      }
    } catch {}
    if (n) { auto.claims = (auto.claims || 0) + n; auto.lastClaim = n; }
    return n;
  }
  const claimRewardsByClick = clickRewardsHere;

  function autoClaimTasks() {
    if (!options.autoClaim) return;
    const now = Date.now();
    if (now - auto.claimAt < 1500) return;
    auto.claimAt = now;
    // 只在对局外（菜单 / 结算页 / 成就页）领，对局中不瞎点
    let inRun = false;
    try { inRun = !!usable(); } catch {}
    if (inRun) return;
    if (claimAllRewards() > 0) return;
    claimRewardsByClick();
  }

  // ===== 回菜单 → 领成就/任务 → 开始新游戏 =====
  // 游戏真实流程（bundle 实证，标准模式共三步）：
  //   1. 主菜单图块 button.mm-item.play —— 内部是
  //        <span class="mm-tx"><b>Jugar</b><small>Modo clásico · 3/12 en tu Liga</small></span>
  //      所以 innerText 是 "Jugar\nModo clásico · …"，绝不能按整串精确匹配。
  //      点它 → HU(app) 渲染选精灵页
  //   2. 选精灵页：出发按钮 button.btn.big.red.ls-go，文案「¡Te elijo a ti!」
  //      点它 → de() → 900ms 后 YU(app, species, 'standard')
  //   3. 区域/难度页：div.rg-go > button.btn.big.red，文案「¡Empezar!」
  //      点它 → E() → app.startRun({species, biome, tier, boosts, mode})
  //
  // 另外：全屏覆盖层里的按钮常常是 position:fixed，此时 offsetParent 恒为 null，
  // 所以不能用 offsetParent 判断可见性（旧代码正是因此一个按钮都点不到）。
  const labelOf = (el) => {
    try {
      const raw = (el.innerText || el.textContent || "").replace(/\r/g, "");
      return raw.split("\n").map((s) => s.trim()).find(Boolean) || "";
    } catch { return ""; }
  };
  const isVisible = (el) => isShown(el);
  const allButtons = () => {
    try { return [...document.querySelectorAll("button,[role=button]")]; } catch { return []; }
  };
  const bySelector = (sel) => {
    try { const el = document.querySelector(sel); return isVisible(el) ? el : null; } catch { return null; }
  };
  const byLabel = (re) => {
    for (const b of allButtons()) {
      if (!isVisible(b)) continue;
      if (re.test(labelOf(b))) return b;
    }
    return null;
  };
  const clickEl = (el) => {
    try { el.click(); return true; } catch { return false; }
  };
  // 1) 标题经过 i18n 翻译，不能只认 Jugar；同一位置的「继续游戏」仍不能点。
  const menuBtn = () => {
    const newRunLabel = /^(Jugar|开始游戏|開始遊戲|Play|StartGame)$/i;
    const tile = bySelector("button.mm-item.play");
    if (tile) {
      // 只读标题，排除图标/副标题；textContent 不受窄屏视觉换行影响。
      const title = tile.querySelector?.(".mm-tx b");
      const label = title ? (title.textContent || title.innerText || "") : labelOf(tile);
      return newRunLabel.test(label.replace(/\s+/g, "")) ? tile : null;
    }
    return byLabel(/^(Jugar|开始游戏|開始遊戲|Play|Start\s*Game)$/i);
  };
  // 2) 选精灵页出发
  const departBtn = () => {
    const b = bySelector("button.ls-go");
    if (!b) return null;
    // 未解锁时按钮 disabled 或文案是 Bloqueado / Captúralo en una partida
    if (/Bloqueado|Captúralo/i.test(labelOf(b))) return null;
    return b;
  };
  // 3) 区域/难度页出发
  const startRunBtn = () => bySelector(".rg-go button") || byLabel(/^¡?Empezar!?$/i);
  const inStarterScreen = () => {
    try { return !!(document.querySelector("button.ls-go") || document.querySelector(".ls-hero") || document.querySelector(".ls-grid")); } catch { return false; }
  };
  const inRegionScreen = () => {
    try { return !!(document.querySelector(".rg-go") || document.querySelector(".rg-regions")); } catch { return false; }
  };
  const inMenuScreen = () => {
    try { return !!(document.querySelector("button.mm-item.play") || document.querySelector(".mm-tiles")); } catch { return false; }
  };
  const pressEsc = () => {
    try {
      const ev = (type) => new KeyboardEvent(type, { key: "Escape", code: "Escape", keyCode: 27, which: 27, bubbles: true });
      document.dispatchEvent(ev("keydown"));
      document.dispatchEvent(ev("keyup"));
      return true;
    } catch { return false; }
  };

  function autoRestartLoop() {
    if (!options.autoLoopRun) return;
    const now = Date.now();
    // 不在对局里才推进流程；对局中什么都不做
    let raw = null;
    try { raw = app?.run; } catch {}
    const inLiveRun = !!raw && !["dead", "over"].includes(raw.state);
    if (inLiveRun) { auto.loopStep = "idle"; auto.loopAt = now; return; }
    if (now - (auto.loopAt || 0) < (options.loopStepMs || 1200)) return;   // 每步之间留出动画/网络时间
    auto.loopAt = now;

    const step = auto.loopStep || "menu";
    switch (step) {
      // 1) 结算页 → 点「菜单」回首页（点不到也要往下走，别卡死在结算页）
      case "menu": {
        if (raw && ["dead", "over"].includes(raw.state)) {
          autoExitToMenu();
          auto.loopTries = (auto.loopTries || 0) + 1;
          if (auto.loopTries <= 2) return;
        }
        auto.loopStep = "goAchievements"; auto.loopTries = 0;
        return;
      }
      // 2) 打开成就页，把能领的全领掉
      case "goAchievements": {
        if (claimAllRewards() > 0) return;                 // 内部 API 直接领完
        auto.loopTries = (auto.loopTries || 0) + 1;
        if (clickRewardsHere()) { auto.pageOpened = true; return; }
        const tile = byLabel(/^Logros$/i);
        if (auto.loopTries <= 2 && tile) { clickEl(tile); auto.pageOpened = true; return; }
        auto.loopStep = "goQuests"; auto.loopTries = 0;
        return;
      }
      // 3) 打开任务页（Encargos），把能领的全领掉
      case "goQuests": {
        if (claimAllRewards() > 0) return;
        auto.loopTries = (auto.loopTries || 0) + 1;
        if (clickRewardsHere()) { auto.pageOpened = true; return; }
        const tile = bySelector("button.mm-item.tasks") || byLabel(/^(Encargos|Tareas)$/i);
        if (auto.loopTries <= 2 && tile) { clickEl(tile); auto.pageOpened = true; return; }
        auto.loopStep = "esc"; auto.loopTries = 0;
        return;
      }
      // 4) 退回主菜单：只有确实打开过子页才按 ESC（否则会把菜单也退掉）
      case "esc": {
        if (!auto.pageOpened && inMenuScreen()) { auto.loopStep = "start"; auto.loopTries = 0; return; }
        if (auto.pageOpened) {
          const back = bySelector("button.back-btn");
          if (back) clickEl(back); else pressEsc();
          auto.pageOpened = false;
        }
        auto.loopStep = "start";
        auto.loopTries = 0;
        return;
      }
      // 5) 点「Jugar」进入选精灵页
      case "start": {
        // 已经站在选精灵页 / 区域页：直接往下走，别点菜单、别 ESC
        if (inStarterScreen()) { auto.loopStep = "depart"; auto.loopTries = 0; return; }
        if (inRegionScreen()) { auto.loopStep = "region"; auto.loopTries = 0; return; }
        // 刚点过「Jugar」，选精灵页可能还在渲染：这段时间绝不能再按 ESC
        if (auto.jugarAt && now - auto.jugarAt < 4000) {
          auto.loopTries = (auto.loopTries || 0) + 1;
          if (auto.loopTries > 10) auto.jugarAt = 0;   // 超时才放弃等待
          return;
        }
        const jugar = menuBtn();
        if (jugar) {
          clickEl(jugar);
          auto.jugarAt = now;                            // 记下点击时刻，给渲染留时间
          auto.loopStep = "depart";
          auto.loopTries = 0;
          return;
        }
        // 找不到「Jugar」才退一层（可能还停在成就/任务子页面）
        if (auto.pageOpened) { pressEsc(); auto.pageOpened = false; }
        auto.loopTries = (auto.loopTries || 0) + 1;
        if (auto.loopTries > 3) { auto.loopStep = "menu"; auto.loopTries = 0; }
        return;
      }
      // 6) 选精灵页 → 点「¡Te elijo a ti!」
      //    绝不在这一页按 ESC：这正是"点开始游戏反而退回菜单"的原因。
      case "depart": {
        const go = departBtn();
        if (go) {
          clickEl(go);
          auto.loopStep = "region";
          auto.loopTries = 0;
          return;
        }
        // 按钮不可用（未解锁/需要挑战）：留在这一页等，不按 ESC
        if (inStarterScreen()) {
          auto.loopTries = (auto.loopTries || 0) + 1;
          if (auto.loopTries > 10) { auto.loopStep = "idle"; auto.loopTries = 0; }  // 放弃本轮，别卡死
          return;
        }
        auto.loopStep = "start"; auto.loopTries = 0;
        return;
      }
      // 7) 区域/难度页 → 点「¡Empezar!」真正开局
      case "region": {
        const go = startRunBtn();
        if (go) {
          clickEl(go);
          auto.loopStep = "waiting";
          auto.loopTries = 0;
          auto.runs = (auto.runs || 0) + 1;
          return;
        }
        if (inRegionScreen()) {
          auto.loopTries = (auto.loopTries || 0) + 1;
          if (auto.loopTries > 10) { auto.loopStep = "idle"; auto.loopTries = 0; }
          return;
        }
        // 没到区域页：可能还在选精灵页或渲染中，退回去等
        auto.loopStep = inStarterScreen() ? "depart" : "start";
        auto.loopTries = 0;
        return;
      }
      // 8) 已点出发，等 startRun 把对局拉起来
      case "waiting": {
        if (inLiveRun) { auto.loopStep = "idle"; auto.jugarAt = 0; return; }
        auto.loopTries = (auto.loopTries || 0) + 1;
        if (auto.loopTries > 12) { auto.loopStep = "start"; auto.loopTries = 0; }
        return;
      }
      default: auto.loopStep = "menu";
    }
  }

  // ===== 对局结束后点「菜单」回首页 =====
  // usable() 会把 dead/over 的对局过滤成 null，所以这里直接看 app.run 的原始状态；
  // 同时必须排除「根本不在对局里」，否则首页上的菜单按钮会被误点。
  function autoExitToMenu() {
    if (!options.autoMenu) return;
    let raw;
    try { raw = app?.run; } catch { return; }
    if (!raw || !["dead", "over"].includes(raw.state)) return;
    const now = Date.now();
    // 同一局只点一次；若 6 秒后仍停在结束界面，允许再试一次
    if (auto.menuDoneFor === raw && now - (auto.menuClickedAt || 0) < 6000) return;
    if (now - auto.menuAt < 500) return;
    auto.menuAt = now;
    try {
      // 不能用 offsetParent 过滤：全屏覆盖层的按钮是 position:fixed，offsetParent 恒为 null
      const menu = byLabel(/^(菜单|選單|Menú|Menu)$/i);
      if (!menu) return;
      auto.menuDoneFor = raw;
      auto.menuClickedAt = now;
      auto.menus = (auto.menus || 0) + 1;
      menu.click();
    } catch {}
  }

  function captureStep(run) {
    const c = run.capture;
    if (!c) return;
    const captureOff = options.safeMode && options.strictRanked && ranked;
    if (["roaming", "weakened"].includes(c.state)) {
      if (!hooked.savedCapture || hooked.captureIndex !== c.index) {
        hooked.captureIndex = c.index;
        hooked.savedCapture = { sure: c.sure, escapeT: c.escapeT, weakT: c.weakT };
      }
      c.sure = (captureOff ? false : options.captureSure) || hooked.savedCapture.sure;
      if (options.noFlee && !captureOff) { c.escapeT = Math.max(c.escapeT, 3600); c.weakT = Math.max(c.weakT, 3600); }
    } else { hooked.savedCapture = null; }
    // ===== 自动捕捉：出现野生精灵 → 打残 → 走近 → 投球 =====
    // 游戏规则：onDefeated(index) 把 roaming 打成 1% 血并切 weakened；
    // canThrow() 要求 state==='weakened' 且玩家距精灵 < 9。
    // 因此必须先自动打残，再靠 autoMove 走过去，最后投球。
    if (options.autoCapture && !captureOff) {
      const capIdx = Number.isFinite(c.index) ? c.index : -1;
      if (c.state === "roaming" && capIdx >= 0) {
        const nowW = Date.now();
        if (!hooked.capWeakenAt || nowW - hooked.capWeakenAt > 900) {
          hooked.capWeakenAt = nowW;
          try { c.onDefeated(capIdx); } catch (error) { lastError = "自动打残: " + error.message; }
        }
      }
      if (c.state === "weakened" && c.canThrow()) {
        try { c.throwBall(); } catch (error) { lastError = "自动投球: " + error.message; }
      }
    }
  }

  function tick() {
    try {
      attach();
      autoResumeAck();
      const run = usable();
      if (queue.active && run !== queue.run) stopQueue("对局已结束或已切换，捕捉队列暂停");
      // 对局已结束（dead/over）时也要推进菜单流程：领奖 → 回菜单 → 开新局。
      // 判据用 app.run 原始状态，因为 usable() 对结束态的处理不保证返回 null。
      let rawOver = false;
      try { rawOver = !!app?.run && ["dead", "over"].includes(app.run.state); } catch {}
      // 不在对局时，尝试自动领取任务 / 对局刚结束时点「菜单」回首页 / 连开新局
      if (!run || rawOver) { autoClaimTasks(); autoExitToMenu(); autoRestartLoop(); if (!run) return; }
      autoContinuePaused(run);
      if (!hooked) return;
      patchAllUI(hooked.ui);          // 补一次弹窗接管（幂等，开销可忽略）
      const o = effective();
      if (o.magnet && run.pickups) run.pickups.magnetAll = 1;
      captureStep(run);
      queueStep(run);
      // 选卡/领奖看门狗：必须在 state!=='play' 的 return 之前，否则弹窗期永远不处理
      if (pendingPick) resolvePendingPick(run);
      if (options.autoBill) resolveFusionModal(run);
      // 祭坛充能完成（游戏把 used 置真）后计一次数，并解除占位
      if (chargingAltar) {
        if (chargingAltar.used) {
          if (!chargingAltar.__pbCounted) { chargingAltar.__pbCounted = true; auto.bless = (auto.bless || 0) + 1; }
          if (goal === chargingAltar) { goal = null; goalAt = 0; goalEvalAt = 0; }
          chargingAltar = null;
        } else if (!run.interactables?.list?.includes(chargingAltar)) {
          if (goal === chargingAltar) { goal = null; goalAt = 0; goalEvalAt = 0; }
          chargingAltar = null;
        }
      }
      if (run.state !== "play" || run.player.dead) return;
      if (options.autoRun) { autoUlt(run); }
      if (o.aura && run.time >= auraAt) {
        auraAt = run.time + 0.5;
        const p = run.player.pos, enemies = run.enemies;
        for (const id of enemies.within(p.x, p.z, o.auraRadius)) {
          if (!enemies.isAlive(id)) continue;
          if (id === run.capture?.index || id === run.allies?.down) continue;
          run.combat.hit(id, o.safeMode ? jitter(o.auraDamage) : o.auraDamage, {
            type: "normal", cls: "special", fixed: true, noReact: true, silent: true, knock: 0,
          });
        }
      }
      lastError = "";
    } catch (error) { lastError = error.message; }
  }

  function queueStep(run) {
    if (!queue.active || run.state !== "play") return;
    try {
      const c = run.capture;
      if (queue.current) {
        if (c.index !== queue.current.index || c.species !== queue.current.id) throw Error("捕捉目标已发生变化，队列暂停");
        if (c.state === "done") {
          if (!queue.current.caught) throw Error("目标未确认捕获，队列暂停");
          queue.items[0].count--; queue.completed++;
          if (!queue.items[0].count) queue.items.shift();
          queue.current = null;
        }
      }
      if (!queue.current) {
        if (!queue.items.length) { stopQueue(); return; }
        const item = queue.items[0];
        api.spawn(item.id, item.variant);
        queue.current = { id: item.id, index: c.index, caught: false };
      }
      if (queue.autoWeaken && c.state === "roaming") { c.onDefeated(c.index); captureStep(run); }
      if (c.state === "weakened" && c.canThrow()) { captureStep(run); if (c.state === "weakened") c.throwBall(); }
    } catch (error) { stopQueue(error.message); }
  }

  const wrappedOpen = async function (...args) {
    const result = await Reflect.apply(originalOpen, this, args);
    app = this;
    auraAt = 0;
    goal = null; goalAt = 0; goalEvalAt = 0; shopCooldowns.clear();
    try { attach(); } catch (error) { lastError = error.message; }
    if (options.autoRun && hooked?.run === this.run) {
      try { autoMove(this.run); } catch (error) { lastError = error.message; }
    } else if (options.autoCapture && hooked?.run === this.run && captureApproach(this.run)) {
      // 只勾自动捕捉
    } else if (lootWanted() && hooked?.run === this.run) {
      try { lootWalk(this.run); } catch (error) { lastError = error.message; }
    }
    return result;
  };
  App.prototype.openRun = wrappedOpen;
  const timer = setInterval(tick, 100);
  // 自动跑图独立高频循环：humanize 时用随机节拍（35-58ms），避免精确周期指纹
  let autoTimer = null, autoStopped = false;
  const autoLoop = () => {
    if (autoStopped) return;
    try {
      // 菜单/结算页的领奖与连开逻辑必须每帧都跑：
      // 它们发生在没有对局的时候，下面的 autoRun 分支根本不会进入。
      // 对局进行中则交给 tick() 的既有调用方（setInterval），这里不重复跑。
      let liveRun = false;
      try { liveRun = !!usable() && app?.run?.state === "play"; } catch {}
      if (!liveRun) { try { tick(); } catch (error) { lastError = error.message; } }
      if (hooked && (options.autoRun || options.autoCapture || lootWanted())) {
        const run = usable();
        if (run && run.state === "play" && !run.player.dead) {
          if (options.autoRun) {
            if (run.pickups) run.pickups.magnetAll = 1;
            autoMove(run);
          } else if (options.autoCapture && captureApproach(run)) {
            // 只勾「自动捕捉」：只要走过去把精灵打残/带走，不做风筝和拾取
          } else if (lootWanted()) {
            lootWalk(run);
          }
        }
      }
    } catch (error) { lastError = error.message; }
    const delay = options.humanize ? 35 + Math.random() * 23 : 40;
    autoTimer = setTimeout(autoLoop, delay);
  };
  autoTimer = setTimeout(autoLoop, 40);
  const api = {
    apply(next) {
      const before = options;
      options = { ...options, ...next };
      match: {
        // 关掉"全图吸附"时把 magnetAll 还原成接管前的值
        if (hooked?.run?.pickups && before.magnet && !options.magnet) {
          hooked.run.pickups.magnetAll = hooked.magnet;
        }
        // 关掉"延长逃跑时间"时，把逃跑/削弱计时还原成原值，否则会一直停在 3600
        if (hooked?.savedCapture && before.noFlee && !options.noFlee) {
          const c = hooked.run?.capture;
          if (c) {
            c.escapeT = hooked.savedCapture.escapeT;
            c.weakT = hooked.savedCapture.weakT;
          }
        }
        // 关掉"必定捕捉"时同理还原
        if (hooked?.savedCapture && before.captureSure && !options.captureSure) {
          const c = hooked.run?.capture;
          if (c) c.sure = hooked.savedCapture.sure;
        }
      }
      attach();
      // 用户点「确定 / 应用」时就该立刻按新设置重选目标。
      // 否则会被 tick 循环里的 700ms 目标重评估节流吞掉：
      // 刚改完开关，人还在原地傻站最多 0.7 秒，看起来像"开关没生效"。
      goalEvalAt = 0;
      if (hooked) { patchAllUI(hooked.ui); setHealth(); hooked.player.recompute(); captureStep(hooked.run); }
      if (options.autoRun && hooked?.run?.state === "play" && !hooked.player.dead) {
        try { autoMove(hooked.run); } catch (error) { lastError = error.message; }
      } else if (options.autoCapture && hooked?.run?.state === "play" && !hooked.player.dead && captureApproach(hooked.run)) {
        // 只勾自动捕捉
      } else if (lootWanted() && hooked?.run?.state === "play" && !hooked.player.dead) {
        try { lootWalk(hooked.run); } catch (error) { lastError = error.message; }
      }
      return api.status();
    },
    status() {
      return {
        installed: true, attached: !!hooked, state: app?.run?.state ?? "menu",
        coop: !!app?.run?.coop, ranked, safeMode: options.safeMode,
        autoRun: options.autoRun, autoLevel: options.autoLevel,
        auto: {
          picks: auto.picks, ults: auto.moves, claims: auto.claims, uiPatched: auto.uiPatched,
          chests: auto.chests || 0, shops: auto.shops || 0, bosses: auto.bosses || 0,
          portals: auto.portals || 0,
          buys: auto.buys || 0,
          items: auto.items || 0, itemPicks: auto.itemPicks || 0, forcePicks: auto.forcePicks || 0,
          fusions: auto.fusions || 0, fusionPicks: auto.fusionPicks || 0, fusionSkip: auto.fusionSkip || 0, fusionFail: auto.fusionFail || 0,
          lastPick: auto.lastPick || null, lastBoard: auto.lastBoard || null,
          bless: auto.bless || 0, blessStart: auto.blessStart || 0,
          rocks: auto.rocks || 0, berries: auto.berries || 0,
          challenges: auto.challenges || 0, bills: auto.bills || 0,
          dittos: auto.dittos || 0, dittoPicks: auto.dittoPicks || 0, dittoSkips: auto.dittoSkips || 0,
          snorlax: auto.snorlax || 0,
          claims: auto.claims || 0, lastClaim: auto.lastClaim || 0,
          loopStep: auto.loopStep || "idle", restarts: auto.runs || 0,
          blessCharging: goal ? goal.kind === "altar" : false,
          pendingPick: !!pendingPick, skillsMaxed: !!(hooked?.run && skillsAllMaxed(hooked.run)),
          fuseReady: !!(hooked?.run && skillsCanFuse(hooked.run)),
          jumps: auto.jumps || 0, mistakes: auto.mistakes || 0,
          goal: goal ? goal.kind : null,
        },
        effective: { damage: effective().damage, area: effective().area, attackSpeed: effective().attackSpeed, moveSpeed: effective().moveSpeed },
        error: lastError,
        hp: hooked ? Math.round(hooked.player.hp) : null,
        maxHp: hooked?.player.maxHp ?? null,
        level: hooked?.player?.level ?? null,
        pendingLevels: app?.run?.pendingLevels ?? null,
        capture: app?.run?.capture ? { state: app.run.capture.state, species: app.run.capture.species } : null,
        queue: {
          active: queue.active, remaining: queue.items.reduce((sum, item) => sum + item.count, 0),
          completed: queue.completed, error: queue.error, target: queue.current?.id ?? queue.items[0]?.id ?? null,
        },
      };
    },
    spawn(id, kind) {
      attach();
      const run = usable();
      if (!run || run.state !== "play") throw Error("请先进入单人对局并继续游戏");
      if (options.safeMode && options.strictRanked && ranked) throw Error("strictRanked 模式禁止指定精灵生成");
      if (!Number.isInteger(id) || id < 1 || id > 151) throw Error("精灵编号必须为 1–151");
      const c = run.capture;
      if (!["idle", "done"].includes(c.state)) throw Error("请先完成当前捕捉遭遇");
      if (kind === "normal") c.spawnEncounter(id);
      else if (kind === "shiny") c.spawnShiny([id]);
      else if (kind === "classic") c.spawnClassic(id);
      else throw Error("未知精灵类型");
      if (c.species !== id || !["roaming", "weakened"].includes(c.state)) throw Error("本局未生成指定精灵，可能缺少资源或不满足出现条件");
      captureStep(run);
      return api.status();
    },
    weaken() {
      const run = usable(), c = run?.capture;
      if (!run || !c || c.state !== "roaming" || !run.enemies.isAlive(c.index)) throw Error("当前没有可削弱的捕捉目标");
      c.onDefeated(c.index); captureStep(run);
      return api.status();
    },
    throwBall() {
      const run = usable(), c = run?.capture;
      if (!c || !c.canThrow()) throw Error("请先削弱目标并靠近到投球距离内");
      captureStep(run);
      if (c.state === "weakened") c.throwBall();
      return api.status();
    },
    setQueue(entries, autoWeaken = true) {
      const run = usable();
      if (!run || run.state !== "play") throw Error("请先开始新的单人对局");
      if (options.safeMode && options.strictRanked && ranked) throw Error("strictRanked 模式禁止捕捉队列");
      if (typeof run.capture?.caught !== "function") throw Error("游戏版本不兼容：找不到捕获回调");
      if (!Array.isArray(entries) || !entries.length || entries.length > 20 || typeof autoWeaken !== "boolean") throw Error("队列需包含 1–20 项");
      const items = entries.map((item) => {
        if (!Number.isInteger(item?.id) || item.id < 1 || item.id > 151 ||
            !["normal", "shiny", "classic"].includes(item.variant) ||
            !Number.isInteger(item.count) || item.count < 1 || item.count > 20) throw Error("队列参数无效：单项数量为 1–20");
        return { id: item.id, variant: item.variant, count: item.count };
      });
      if (items.reduce((sum, item) => sum + item.count, 0) > 100) throw Error("队列总数量不能超过 100");
      if (queue.active || !["idle", "done"].includes(run.capture.state)) throw Error("请先停止队列并完成当前遭遇");
      queue = { active: true, items, current: null, completed: 0, error: "", autoWeaken, run };
      queueStep(run);
      return api.status();
    },
    stopQueue() { stopQueue(); return api.status(); },
    // 快捷开关
    auto(on = true) { options = { ...options, autoRun: !!on }; return api.status(); },
    dispose() {
      clearInterval(timer);
      autoStopped = true;
      if (autoTimer) clearTimeout(autoTimer);
      stopQueue();
      restore();
      if (App.prototype.openRun === wrappedOpen) App.prototype.openRun = originalOpen;
      delete globalThis.__PB_DESKTOP_V1__;
      return true;
    },
  };
  globalThis.__PB_DESKTOP_V1__ = api;
  return api.status();
})()

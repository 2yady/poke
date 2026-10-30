(async function installPB() {
  "use strict";
  if (globalThis.__PB_DESKTOP_V1__) return globalThis.__PB_DESKTOP_V1__.status();
  const entry = [...document.querySelectorAll('link[rel="modulepreload"]')]
    .find((link) => /\/assets\/main-[^/]+\.js$/.test(new URL(link.href).pathname));
  if (!entry) throw Error("游戏模块尚未加载，请稍后重试");
  const { App } = await import(entry.href);
  if (typeof App?.prototype.openRun !== "function") throw Error("游戏版本不兼容：找不到开局入口");
  const originalOpen = App.prototype.openRun;
  let app = null, hooked = null, lastError = "", auraAt = 0;
  let options = {
    god: false, magnet: false, pickup: 1, damage: 1, area: 1,
    attackSpeed: 1, moveSpeed: 1, aura: false, auraRadius: 12, auraDamage: 50,
    captureSure: false, noFlee: false, autoCapture: false,
  };
  let queue = { active: false, items: [], current: null, completed: 0, error: "", autoWeaken: true, run: null };
  function stopQueue(error = "") { queue.active = false; queue.error = error; }
  function usable() {
    const run = app?.run;
    return run && !run.coop && !["dead", "over"].includes(run.state) ? run : null;
  }
  function restore() {
    if (!hooked) return;
    const { player, descriptor, recompute, patchedRecompute, run, magnet } = hooked;
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
    hooked = null;
    recompute.call(player);
  }
  function setHealth() {
    const h = hooked, p = h.player;
    if (options.god && !h.locked && !p.dead) {
      Object.defineProperty(p, "hp", {
        configurable: true, enumerable: h.descriptor.enumerable,
        get() { return this.maxHp; }, set(_value) {},
      });
      h.locked = true;
    } else if (!options.god && h.locked) {
      const value = p.hp;
      Object.defineProperty(p, "hp", { ...h.descriptor, value });
      h.locked = false;
    }
  }
  function attach() {
    const run = usable();
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
      this.stats.damage *= options.damage;
      this.stats.area *= options.area;
      this.stats.attackSpeed *= options.attackSpeed;
      this.stats.moveSpeed *= options.moveSpeed;
      this.stats.pickupRange = Math.max(this.stats.pickupRange, options.pickup);
      return result;
    };
    hooked = {
      run, player, descriptor, recompute, patchedRecompute,
      ownRecompute: Object.getOwnPropertyDescriptor(player, "recompute"),
      locked: false, magnet: run.pickups?.magnetAll ?? 0, savedCapture: null,
      ownCaught: run.capture ? Object.getOwnPropertyDescriptor(run.capture, "caught") : null,
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
    setHealth();
    player.recompute();
  }
  function captureStep(run) {
    const c = run.capture;
    if (!c) return;
    if (["roaming", "weakened"].includes(c.state)) {
      if (!hooked.savedCapture || hooked.captureIndex !== c.index) {
        hooked.captureIndex = c.index;
        hooked.savedCapture = { sure: c.sure, escapeT: c.escapeT, weakT: c.weakT };
      }
      c.sure = options.captureSure || hooked.savedCapture.sure;
      if (options.noFlee) { c.escapeT = Math.max(c.escapeT, 3600); c.weakT = Math.max(c.weakT, 3600); }
    } else { hooked.savedCapture = null; }
    if (options.autoCapture && c.state === "weakened" && c.canThrow()) c.throwBall();
  }
  function tick() {
    try {
      attach();
      const run = usable();
      if (queue.active && run !== queue.run) stopQueue("对局已结束或已切换，捕捉队列暂停");
      if (!run || !hooked) return;
      if (options.magnet && run.pickups) run.pickups.magnetAll = 1;
      captureStep(run);
      queueStep(run);
      if (run.state !== "play" || run.player.dead) return;
      if (options.aura && run.time >= auraAt) {
        auraAt = run.time + 0.5;
        const p = run.player.pos, enemies = run.enemies;
        for (const id of enemies.within(p.x, p.z, options.auraRadius)) {
          if (!enemies.isAlive(id)) continue;
          if (id === run.capture?.index || id === run.allies?.down) continue;
          run.combat.hit(id, options.auraDamage, {
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
        if (c.index !== queue.current.index || c.species !== queue.current.id) {
          throw Error("捕捉目标已发生变化，队列暂停");
        }
        if (c.state === "done") {
          if (!queue.current.caught) throw Error("目标未确认捕获，队列暂停");
          queue.items[0].count--;
          queue.completed++;
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
      if (queue.autoWeaken && c.state === "roaming") {
        c.onDefeated(c.index);
        captureStep(run);
      }
      if (c.state === "weakened" && c.canThrow()) { captureStep(run); if (c.state === "weakened") c.throwBall(); }
    } catch (error) { stopQueue(error.message); }
  }
  const wrappedOpen = async function (...args) {
    const result = await Reflect.apply(originalOpen, this, args);
    app = this;
    auraAt = 0;
    try { attach(); } catch (error) { lastError = error.message; }
    return result;
  };
  App.prototype.openRun = wrappedOpen;
  const timer = setInterval(tick, 100);
  const api = {
    apply(next) {
      const old = options;
      if (hooked && old.magnet && !next.magnet) hooked.run.pickups.magnetAll = hooked.magnet;
      if (hooked?.savedCapture && old.noFlee && !next.noFlee) {
        hooked.run.capture.escapeT = hooked.savedCapture.escapeT;
        hooked.run.capture.weakT = hooked.savedCapture.weakT;
      }
      options = { ...options, ...next };
      attach();
      if (hooked) { setHealth(); hooked.player.recompute(); captureStep(hooked.run); }
      return api.status();
    },
    status() {
      return {
        installed: true, attached: !!hooked, state: app?.run?.state ?? "menu",
        coop: !!app?.run?.coop, error: lastError,
        hp: hooked ? Math.round(hooked.player.hp) : null,
        maxHp: hooked?.player.maxHp ?? null,
        capture: app?.run?.capture ? {
          state: app.run.capture.state, species: app.run.capture.species,
        } : null,
        queue: {
          active: queue.active, remaining: queue.items.reduce((sum, item) => sum + item.count, 0),
          completed: queue.completed, error: queue.error,
          target: queue.current?.id ?? queue.items[0]?.id ?? null,
        },
      };
    },
    spawn(id, kind) {
      attach();
      const run = usable();
      if (!run || run.state !== "play") throw Error("请先进入单人对局并继续游戏");
      if (!Number.isInteger(id) || id < 1 || id > 151) throw Error("精灵编号必须为 1–151");
      const c = run.capture;
      if (!["idle", "done"].includes(c.state)) throw Error("请先完成当前捕捉遭遇");
      if (kind === "normal") c.spawnEncounter(id);
      else if (kind === "shiny") c.spawnShiny([id]);
      else if (kind === "classic") c.spawnClassic(id);
      else throw Error("未知精灵类型");
      if (c.species !== id || !["roaming", "weakened"].includes(c.state)) {
        throw Error("本局未生成指定精灵，可能缺少资源或不满足出现条件");
      }
      captureStep(run);
      return api.status();
    },
    weaken() {
      const run = usable(), c = run?.capture;
      if (!run || !c || c.state !== "roaming" || !run.enemies.isAlive(c.index)) {
        throw Error("当前没有可削弱的捕捉目标");
      }
      c.onDefeated(c.index);
      captureStep(run);
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
      if (typeof run.capture?.caught !== "function") throw Error("游戏版本不兼容：找不到捕获回调");
      if (!Array.isArray(entries) || !entries.length || entries.length > 20 ||
          typeof autoWeaken !== "boolean") throw Error("队列需包含 1–20 项");
      const items = entries.map((item) => {
        if (!Number.isInteger(item?.id) || item.id < 1 || item.id > 151 ||
            !["normal", "shiny", "classic"].includes(item.variant) ||
            !Number.isInteger(item.count) || item.count < 1 || item.count > 20) {
          throw Error("队列参数无效：单项数量为 1–20");
        }
        return { id: item.id, variant: item.variant, count: item.count };
      });
      if (items.reduce((sum, item) => sum + item.count, 0) > 100) throw Error("队列总数量不能超过 100");
      if (queue.active || !["idle", "done"].includes(run.capture.state)) throw Error("请先停止队列并完成当前遭遇");
      queue = { active: true, items, current: null, completed: 0, error: "", autoWeaken, run };
      queueStep(run);
      return api.status();
    },
    stopQueue() { stopQueue(); return api.status(); },
    dispose() {
      clearInterval(timer);
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

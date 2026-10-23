const { CLOSINGS } = require('../data/scenes');

function shuffle(list) {
  const result = list.slice();
  for (let i = result.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    const temp = result[i];
    result[i] = result[j];
    result[j] = temp;
  }
  return result;
}

function orderedByFreshness(pool, usedMap) {
  const fresh = [];
  const rest = [];
  const seen = Object.create(null);
  const shuffled = shuffle(pool || []);
  for (let i = 0; i < shuffled.length; i += 1) {
    const value = shuffled[i];
    if (!value || seen[value]) continue;
    seen[value] = true;
    if (usedMap[value]) rest.push(value);
    else fresh.push(value);
  }
  return fresh.concat(rest);
}

function normalizeName(value) {
  return String(value || '')
    .replace(/[\r\n\t]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[\s，。！？、：；,.!?:;]+|[\s，。！？、：；,.!?:;]+$/g, '')
    .slice(0, 20);
}

function salutation(scene, style, name) {
  if (scene.id === 'wedding') {
    if (name) return style === 'formal' ? name + '：' : name + '，';
    if (style === 'formal') return '尊敬的二位：';
    if (style === 'concise') return '';
    return '两位新人，';
  }
  if (style === 'formal') return name ? name + '：' : '尊敬的您：';
  if (style === 'concise') return name ? name + '，' : '';
  if (style === 'humorous') return name ? name + '，' : '朋友，';
  return name ? name + '，' : '亲爱的朋友，';
}

function ensurePeriod(text) {
  if (!text) return '';
  return /[。！？…”」』]$/.test(text) ? text : text + '。';
}

const KEY_PHRASES = [
  '谨向您',
  '谨以此',
  '谨此',
  '谨祝',
  '向您',
  '诚挚',
  '佳节',
  '琴瑟和鸣',
  '衷心感谢',
  '衷心祝愿',
  '衷心',
  '愿二位',
  '祝贺',
  '真诚的谢意',
  '诚挚的谢意',
  '这份情谊',
  '感谢您',
  '身心康',
  '阖家',
  '乔迁',
  '新居',
  '新气象',
  '新的一岁',
  '新婚',
  '合作',
  '愿所有',
  '热爱',
  '百年好合',
  '前程',
  '平安喜乐',
  '诸事顺',
  '身体健康',
  '工作顺利',
  '万事顺遂',
  '岁岁平安',
  '良辰吉日',
  '值此佳节',
];

function sharesKeyPhrase(parts, text) {
  for (let i = 0; i < KEY_PHRASES.length; i += 1) {
    const phrase = KEY_PHRASES[i];
    if (text.indexOf(phrase) < 0) continue;
    for (let j = 0; j < parts.length; j += 1) {
      if (parts[j].indexOf(phrase) >= 0) return true;
    }
  }
  return false;
}

function sharesFormalOpener(parts, text) {
  const openers = ['谨祝', '衷心祝愿', '衷心感谢', '谨向', '再次'];
  for (let i = 0; i < openers.length; i += 1) {
    if (text.indexOf(openers[i]) !== 0) continue;
    for (let j = 0; j < parts.length; j += 1) {
      if (parts[j].indexOf(openers[i]) === 0) return true;
    }
  }
  return false;
}

function firstUnused(pool, usedMap) {
  const items = orderedByFreshness(pool, usedMap);
  for (let i = 0; i < items.length; i += 1) {
    if (!usedMap[items[i]]) return items[i];
  }
  return '';
}

function addFromPool(pool, count, usedMap, add, ignoreKey) {
  const items = orderedByFreshness(pool, usedMap);
  let added = 0;
  for (let i = 0; i < items.length && added < count; i += 1) {
    if (add(items[i], ignoreKey)) {
      usedMap[items[i]] = true;
      added += 1;
    }
  }
}

function buildOne(scene, style, length, role, name, used) {
  const parts = [];
  const local = Object.create(null);
  const add = (text, ignoreKey) => {
    if (!text || local[text]) return false;
    if (!ignoreKey && sharesKeyPhrase(parts, text)) return false;
    local[text] = true;
    parts.push(text);
    return true;
  };

  const wantOpening =
    length === 'long' ||
    (length === 'medium' && style !== 'concise' && Math.random() < 0.7);

  if (wantOpening) {
    const opening = firstUnused(
      (scene.openings[style] || []).filter(Boolean),
      used.openings
    );
    if (opening) {
      add(opening);
      used.openings[opening] = true;
    }
  }

  const relationSource =
    style === 'formal' && scene.formalRelationWishes
      ? scene.formalRelationWishes
      : scene.relationWishes;
  const relationPool = role ? relationSource[role] || [] : [];
  if (
    relationPool.length &&
    (length !== 'short' || Math.random() < 0.6)
  ) {
    const relationLine = firstUnused(relationPool, used.relations);
    if (relationLine) {
      add(relationLine);
      used.relations[relationLine] = true;
    }
  }

  const addWishes = (count) => {
    if (count > 0) addFromPool(scene.wishes[style] || [], count, used.wishes, add);
  };

  if (length === 'short') {
    addWishes(parts.length === 0 ? 1 : 0);
  } else if (length === 'medium') {
    addWishes(2);
  } else {
    addWishes(1);
    const details = (scene.longDetails && scene.longDetails[style]) || [];
    const candidates = orderedByFreshness(details, used.details).filter(
      (item) => item && !local[item]
    );
    let picked = '';
    for (let i = 0; i < candidates.length; i += 1) {
      if (add(candidates[i])) {
        picked = candidates[i];
        break;
      }
    }
    if (!picked && candidates.length) {
      picked = candidates[0];
      local[picked] = true;
      parts.push(picked);
    }
    if (picked) {
      used.details[picked] = true;
    } else {
      addWishes(1);
    }
    addWishes(1);
  }

  const closings = orderedByFreshness(
    CLOSINGS[style] || CLOSINGS.warm,
    used.closings
  );
  let closing = '';
  for (let i = 0; i < closings.length; i += 1) {
    if (sharesFormalOpener(parts, closings[i])) continue;
    if (add(closings[i])) {
      closing = closings[i];
      used.closings[closing] = true;
      break;
    }
  }
  if (!closing && closings.length) {
    closing = closings[0];
    parts.push(closing);
    used.closings[closing] = true;
  }

  const minParts = length === 'long' ? 4 : length === 'medium' ? 3 : 2;
  if (parts.length < minParts) {
    addFromPool(scene.wishes[style] || [], minParts - parts.length, used.wishes, add);
    if (parts.length < minParts) {
      addFromPool(
        scene.wishes[style] || [],
        minParts - parts.length,
        used.wishes,
        add,
        true
      );
    }
  }

  return {
    text: salutation(scene, style, name) + parts.map(ensurePeriod).join(''),
    parts,
  };
}

function overlapRatio(parts, previousParts) {
  if (!previousParts || !previousParts.length || !parts.length) return 0;
  const set = Object.create(null);
  for (let i = 0; i < previousParts.length; i += 1) {
    set[previousParts[i]] = true;
  }
  let shared = 0;
  for (let i = 0; i < parts.length; i += 1) {
    if (set[parts[i]]) shared += 1;
  }
  return shared / parts.length;
}

function maxOverlapRatio(parts, groups) {
  let max = 0;
  for (let i = 0; i < groups.length; i += 1) {
    const ratio = overlapRatio(parts, groups[i]);
    if (ratio > max) max = ratio;
  }
  return max;
}

function createUsed() {
  return {
    openings: Object.create(null),
    wishes: Object.create(null),
    relations: Object.create(null),
    details: Object.create(null),
    closings: Object.create(null),
  };
}

function cloneUsed(source) {
  const next = createUsed();
  const keys = ['openings', 'wishes', 'relations', 'details', 'closings'];
  for (let i = 0; i < keys.length; i += 1) {
    const key = keys[i];
    const names = Object.keys(source[key]);
    for (let j = 0; j < names.length; j += 1) {
      next[key][names[j]] = true;
    }
  }
  return next;
}

function generate(options) {
  const scene = options.scene;
  const style = options.style || 'warm';
  const length = options.length || 'medium';
  const role = options.role || '';
  const name = normalizeName(options.name);
  const avoidGroups = Array.isArray(options.avoidGroups)
    ? options.avoidGroups
    : [];

  let used = createUsed();
  const results = [];
  const texts = Object.create(null);
  const firstParts = Object.create(null);

  const limits = [0.6, 0.8];
  for (let phase = 0; phase < limits.length; phase += 1) {
    let attempts = 0;
    while (results.length < 3 && attempts < 120) {
      attempts += 1;
      const trial = cloneUsed(used);
      const built = buildOne(scene, style, length, role, name, trial);
      if (texts[built.text]) continue;
      if (firstParts[built.parts[0]]) continue;
      if (maxOverlapRatio(built.parts, avoidGroups) >= limits[phase]) {
        continue;
      }
      used = trial;
      texts[built.text] = true;
      firstParts[built.parts[0]] = true;
      results.push(built);
    }
  }

  let attempts = 0;
  while (results.length < 3 && attempts < 240) {
    attempts += 1;
    const trial = cloneUsed(used);
    const built = buildOne(scene, style, length, role, name, trial);
    if (texts[built.text]) continue;
    if (firstParts[built.parts[0]]) continue;
    used = trial;
    texts[built.text] = true;
    firstParts[built.parts[0]] = true;
    results.push(built);
  }

  attempts = 0;
  while (results.length < 3 && attempts < 240) {
    attempts += 1;
    const trial = cloneUsed(used);
    const built = buildOne(scene, style, length, role, name, trial);
    if (texts[built.text]) continue;
    used = trial;
    texts[built.text] = true;
    results.push(built);
  }

  const groups = results.map((item) => item.parts.slice());
  const allParts = [];
  for (let i = 0; i < groups.length; i += 1) {
    for (let j = 0; j < groups[i].length; j += 1) {
      allParts.push(groups[i][j]);
    }
  }

  return {
    results: results.map((item, index) => ({
      id: index + 1,
      text: item.text,
    })),
    groups,
    parts: allParts,
  };
}

module.exports = {
  generate,
  normalizeName,
};

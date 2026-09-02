function frozenStrings(values) {
  return Object.freeze([...values]);
}

function runtimeDefinition({
  id,
  aliases,
  directAliases = [],
  defaultModel = '',
  canonicalDefault = defaultModel,
  models = [],
  efforts = [],
  capabilities,
}) {
  return Object.freeze({
    id,
    aliases: frozenStrings(aliases),
    directAliases: frozenStrings(directAliases),
    defaultModel,
    canonicalDefault,
    models: frozenStrings(models),
    efforts: frozenStrings(efforts),
    capabilities: Object.freeze({ ...capabilities }),
  });
}

export const DEFAULT_RUNTIME_ID = 'codex';

export const RUNTIME_CATALOG = Object.freeze({
  codex: runtimeDefinition({
    id: 'codex',
    aliases: ['codex'],
    efforts: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'],
    capabilities: {
      modelCatalog: 'dynamic',
      effortControl: 'selectable',
      activeInput: 'steer',
      scopePolicy: 'any',
      outputOwnership: 'runtime',
      sessionAuthority: 'preserve-process',
    },
  }),
  claude: runtimeDefinition({
    id: 'claude',
    aliases: ['claude'],
    canonicalDefault: 'claude',
    models: ['sonnet', 'opus', 'haiku', 'fable'],
    efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    capabilities: {
      modelCatalog: 'static',
      effortControl: 'selectable',
      activeInput: 'steer',
      scopePolicy: 'any',
      outputOwnership: 'runtime',
      sessionAuthority: 'preserve-process',
    },
  }),
  volc: runtimeDefinition({
    id: 'volc',
    aliases: ['volc', 'volcengine', 'ark'],
    directAliases: ['volc', 'volcengine', 'ark'],
    defaultModel: 'ark',
    models: ['ark'],
    efforts: ['managed'],
    capabilities: {
      modelCatalog: 'static',
      effortControl: 'remote-managed',
      activeInput: 'queue-next-turn',
      scopePolicy: 'single-conversation',
      outputOwnership: 'runtime',
      sessionAuthority: 'rotate',
    },
  }),
  pi: runtimeDefinition({
    id: 'pi',
    aliases: ['pi'],
    directAliases: ['pi'],
    canonicalDefault: 'pi',
    efforts: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
    capabilities: {
      modelCatalog: 'dynamic',
      effortControl: 'selectable',
      activeInput: 'steer',
      scopePolicy: 'any',
      outputOwnership: 'runtime',
      sessionAuthority: 'preserve-process',
    },
  }),
});

export const RUNTIME_IDS = frozenStrings(Object.keys(RUNTIME_CATALOG));

export const RUNTIME_ALIASES = Object.freeze(Object.fromEntries(
  RUNTIME_IDS.flatMap((id) => RUNTIME_CATALOG[id].aliases.map((alias) => [alias, id])),
));

export function getRuntimeDefinition(runtimeOrAlias) {
  const id = Object.hasOwn(RUNTIME_ALIASES, runtimeOrAlias)
    ? RUNTIME_ALIASES[runtimeOrAlias]
    : runtimeOrAlias;
  return Object.hasOwn(RUNTIME_CATALOG, id) ? RUNTIME_CATALOG[id] : null;
}

export function isDirectRuntimeAlias(value) {
  const raw = String(value ?? '');
  return RUNTIME_IDS.some((id) => RUNTIME_CATALOG[id].directAliases.includes(raw));
}

export function staticModelEntries(runtime = null) {
  const definitions = runtime
    ? [getRuntimeDefinition(runtime)].filter(Boolean)
    : RUNTIME_IDS.map((id) => RUNTIME_CATALOG[id]);
  return definitions.flatMap((definition) => definition.models.map((id) => ({
    id,
    efforts: definition.efforts,
  })));
}

export function parseRuntimeModelSelector(value) {
  const raw = String(value ?? '');
  const qualified = /^([^:]+):(.*)$/.exec(raw);
  const qualifier = qualified && Object.hasOwn(RUNTIME_ALIASES, qualified[1])
    ? qualified[1]
    : null;
  if (qualifier) {
    return {
      raw,
      qualified: true,
      qualifier,
      runtime: RUNTIME_ALIASES[qualifier],
      model: qualified[2],
    };
  }
  const direct = RUNTIME_IDS
    .map((id) => RUNTIME_CATALOG[id])
    .find((definition) => definition.directAliases.includes(raw));
  return {
    raw,
    qualified: false,
    qualifier: null,
    runtime: null,
    model: direct?.defaultModel ?? raw,
  };
}

function staticModelRuntime(model) {
  return RUNTIME_IDS.find((id) => RUNTIME_CATALOG[id].models.includes(model)) ?? null;
}

export function modelMatchesRuntime(model, runtimeOrAlias) {
  const definition = getRuntimeDefinition(runtimeOrAlias);
  if (!definition) return false;
  const owner = staticModelRuntime(model);
  // Dynamic catalogs (Codex, Pi) share the unowned leftover; static catalogs
  // only match ids they published. Otherwise `pi:openai/gpt-4o` cannot see
  // the live Pi list and unprefixed live ids look like Codex names.
  if (definition.capabilities.modelCatalog === 'dynamic') {
    return owner === null || owner === definition.id;
  }
  return owner === definition.id;
}

export function resolveRuntimeModelTarget(value, currentRuntime = null) {
  const selector = parseRuntimeModelSelector(value);
  if (selector.qualified) {
    const definition = RUNTIME_CATALOG[selector.runtime];
    const model = selector.model || definition.defaultModel;
    return {
      runtime: definition.id,
      model,
      canonical: model || definition.canonicalDefault,
    };
  }

  const direct = RUNTIME_IDS
    .map((id) => RUNTIME_CATALOG[id])
    .find((definition) => definition.directAliases.includes(selector.raw));
  if (direct) {
    return {
      runtime: direct.id,
      model: direct.defaultModel,
      canonical: direct.defaultModel || direct.canonicalDefault,
    };
  }

  const owner = staticModelRuntime(selector.model);
  if (owner) {
    return { runtime: owner, model: selector.model, canonical: selector.model };
  }
  const current = getRuntimeDefinition(currentRuntime);
  if (current?.capabilities.modelCatalog === 'dynamic') {
    return {
      runtime: current.id,
      model: selector.model,
      canonical: selector.model || current.canonicalDefault,
    };
  }
  return { runtime: DEFAULT_RUNTIME_ID, model: selector.model, canonical: selector.model };
}

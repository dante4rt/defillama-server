import parentProtocolsList from "../../protocols/parentProtocols";
import type { IParentProtocol } from "../../protocols/types";
import type { LiteProtocol } from "../../types";
import { extraSectionsSet } from "../../utils/normalizeChain";

const EXCLUDE_PARENT_SLOT = "excludeParent";
const NULL_SYMBOL = "-";
const SYNTHETIC_CHAIN_KEYS = new Set([
  EXCLUDE_PARENT_SLOT,
  "doublecounted",
  "liquidstaking",
  "dcAndLsOverlap",
]);

interface ChildProtocol {
  id: string;
  name: string;
  symbol: string | null;
  tvl: number | null;
  chains: string[];
  excludedFromParentTvl?: boolean;
}

export interface ParentProtocolEntry extends IParentProtocol {
  tvl: number | null;
  chainTvls: { [chain: string]: number };
  mcap: number | null;
  childProtocols: ChildProtocol[];
}

interface ChildExclusionMeta {
  excludeTvlFromParent?: boolean;
  tokensExcludedFromParent?: { [chain: string]: string[] };
}

interface Protocols2DataLike {
  protocols: LiteProtocol[];
  parentProtocols: Array<IParentProtocol & { mcap?: number | null }>;
}

export function getParentProtocolsInternal(
  protocols2Data: Protocols2DataLike,
  childMetadataById: Map<string, ChildExclusionMeta> = new Map(),
): ParentProtocolEntry[] {
  const { protocols, parentProtocols } = protocols2Data;

  const childrenByParent = new Map<string, LiteProtocol[]>();
  for (const protocol of protocols) {
    const parentId = protocol.parentProtocol;
    if (!parentId) continue;
    const bucket = childrenByParent.get(parentId);
    if (bucket) bucket.push(protocol);
    else childrenByParent.set(parentId, [protocol]);
  }

  const parentMetaById = new Map(parentProtocols.map((p) => [p.id, p]));

  const result: ParentProtocolEntry[] = [];

  for (const baseParent of parentProtocolsList) {
    if (baseParent.deprecated) continue;

    const enriched = parentMetaById.get(baseParent.id);
    const children = childrenByParent.get(baseParent.id) ?? [];

    let tvl: number | null = null;
    const chainTvls: { [chain: string]: number } = {};
    const childProtocols: ChildProtocol[] = [];
    let inferredSymbol: string | null = null;

    for (const child of children) {
      const meta = childMetadataById.get(child.defillamaId);
      const hasExclusion =
        meta?.excludeTvlFromParent === true ||
        meta?.tokensExcludedFromParent !== undefined;

      const childTvl = child.tvl;
      // When slot is absent (cache lag) but meta declares any exclusion,
      // fall back to full exclusion so the `excludedFromParentTvl` flag
      // never disagrees with the contribution counted into parent tvl.
      const slotTotalExcluded = child.chainTvls[EXCLUDE_PARENT_SLOT]?.tvl;
      const totalExcluded =
        slotTotalExcluded ??
        (hasExclusion && childTvl !== null ? childTvl : 0);

      if (childTvl !== null) {
        const contribution = childTvl - totalExcluded;
        if (contribution > 0) tvl = (tvl ?? 0) + contribution;
      }

      for (const [chain, value] of Object.entries(child.chainTvls)) {
        if (chain.includes("-") || extraSectionsSet.has(chain) || SYNTHETIC_CHAIN_KEYS.has(chain)) continue;
        const tvlValue = value?.tvl;
        if (typeof tvlValue !== "number") continue;
        const slotChainExcluded = child.chainTvls[`${chain}-${EXCLUDE_PARENT_SLOT}`]?.tvl;
        const chainHasTokenExclusion =
          (meta?.tokensExcludedFromParent?.[chain]?.length ?? 0) > 0;
        const chainExcluded =
          slotChainExcluded ??
          (meta?.excludeTvlFromParent || chainHasTokenExclusion ? tvlValue : 0);
        const contribution = tvlValue - chainExcluded;
        if (contribution > 0) chainTvls[chain] = (chainTvls[chain] ?? 0) + contribution;
      }

      if (inferredSymbol === null && child.symbol && child.symbol !== NULL_SYMBOL) {
        inferredSymbol = child.symbol;
      }

      const childEntry: ChildProtocol = {
        id: child.defillamaId,
        name: child.name,
        symbol: child.symbol && child.symbol !== NULL_SYMBOL ? child.symbol : null,
        tvl: childTvl,
        chains: child.chains,
      };
      if (hasExclusion || totalExcluded > 0) childEntry.excludedFromParentTvl = true;
      childProtocols.push(childEntry);
    }

    result.push({
      ...baseParent,
      symbol: baseParent.symbol ?? inferredSymbol ?? null,
      chains: enriched?.chains ?? baseParent.chains,
      mcap: enriched?.mcap ?? null,
      tvl,
      chainTvls,
      childProtocols,
    });
  }

  return result;
}

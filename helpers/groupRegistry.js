// Shared in-memory group registry.
// The joiner writes here immediately after each successful join.
// The messenger reads from here so it sees new groups without a DB round-trip.

const registry = new Map(); // accountId (string) → groupInfo[]

export function initGroups(accountId, groups) {
  registry.set(accountId.toString(), [...groups]);
}

export function addGroup(accountId, groupInfo) {
  const id = accountId.toString();
  if (!registry.has(id)) registry.set(id, []);
  const groups = registry.get(id);
  if (!groups.some(g => g.link === groupInfo.link)) {
    groups.push(groupInfo);
  }
}

export function removeGroup(accountId, link) {
  const id = accountId.toString();
  const groups = registry.get(id);
  if (groups) registry.set(id, groups.filter(g => g.link !== link));
}

export function getGroups(accountId) {
  return registry.get(accountId.toString()) || [];
}

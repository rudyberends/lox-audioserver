import { API_BASE } from '../config/apiConfig';

export type GroupRecord = {
  leader: number;
  leaderName: string;
  members: number[];
  memberNames: string[];
  backend: string;
  externalId: string | null;
  source: string;
  updatedAt: number;
};

export type GroupsResponse = {
  groups?: GroupRecord[];
};

export async function fetchGroups(): Promise<GroupRecord[]> {
  const res = await fetch(`${API_BASE}/groups`);
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(text || 'Failed to fetch groups');
  }
  const data = (await res.json()) as GroupsResponse;
  return data.groups ?? [];
}

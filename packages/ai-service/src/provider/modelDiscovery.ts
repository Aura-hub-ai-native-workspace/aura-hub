export async function fetchModels(baseUrl: string, apiKey: string, _providerId?: string): Promise<{ id: string; name: string }[]> {
  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, '')}/models`, {
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return [];
    const json = await res.json() as { data?: { id: string }[] };
    return (json.data ?? []).map((m) => ({ id: m.id, name: m.id }));
  } catch { return []; }
}

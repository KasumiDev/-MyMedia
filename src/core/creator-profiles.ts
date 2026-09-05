export interface CreatorProfile {
  accountId: string;
  username: string;
}

export function selectCreatorProfiles(json: unknown): CreatorProfile[] {
  const response = recordFrom(json)?.response;
  const responseRecord = recordFrom(response);
  const accounts = Array.isArray(response)
    ? response
    : Array.isArray(responseRecord?.accounts)
      ? responseRecord.accounts
      : responseRecord?.account
        ? [responseRecord.account]
        : [];

  return accounts.flatMap((value) => {
    const account = recordFrom(value);
    const accountId = idFrom(account?.id);
    const username = stringFrom(account?.username);
    return accountId && username
      ? [{ accountId, username }]
      : [];
  });
}

function recordFrom(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function idFrom(value: unknown): string | null {
  const id = typeof value === "string" || typeof value === "number"
    ? String(value)
    : "";
  return /^\d{6,30}$/u.test(id) ? id : null;
}

function stringFrom(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim().slice(0, 100)
    : null;
}

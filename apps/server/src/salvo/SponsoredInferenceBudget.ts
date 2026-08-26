export type SponsoredInferenceBudgetConfig = {
  readonly pilotCapMicros: number;
  readonly perUserCapMicros: number;
  readonly perTurnCapMicros: number;
};

export type SponsoredInferenceReservation = {
  readonly id: string;
  readonly userId: string;
  readonly turnId: string;
  readonly reservedMicros: number;
  readonly state: "reserved" | "committed" | "released";
  readonly billedMicros: number;
};

export type SponsoredInferenceBudgetState = {
  readonly reservations: Readonly<Record<string, SponsoredInferenceReservation>>;
};

export type ReserveResult =
  | {
      readonly ok: true;
      readonly state: SponsoredInferenceBudgetState;
      readonly reservation: SponsoredInferenceReservation;
      readonly replayed: boolean;
    }
  | {
      readonly ok: false;
      readonly reason: "invalid_amount" | "per_turn_cap" | "per_user_cap" | "pilot_cap";
    };

const validMicros = (value: number) => Number.isSafeInteger(value) && value > 0;

const chargedMicros = (reservation: SponsoredInferenceReservation) =>
  reservation.state === "committed"
    ? reservation.billedMicros
    : reservation.state === "reserved"
      ? reservation.reservedMicros
      : 0;

const totalFor = (state: SponsoredInferenceBudgetState, userId?: string) =>
  Object.values(state.reservations)
    .filter((reservation) => userId === undefined || reservation.userId === userId)
    .reduce((total, reservation) => total + chargedMicros(reservation), 0);

export const emptySponsoredInferenceBudget = (): SponsoredInferenceBudgetState => ({
  reservations: {},
});

export function reserveSponsoredInference(
  state: SponsoredInferenceBudgetState,
  config: SponsoredInferenceBudgetConfig,
  input: {
    readonly id: string;
    readonly userId: string;
    readonly turnId: string;
    readonly amountMicros: number;
  },
): ReserveResult {
  const existing = state.reservations[input.id];
  if (existing) {
    const sameRequest =
      existing.userId === input.userId &&
      existing.turnId === input.turnId &&
      existing.reservedMicros === input.amountMicros;
    return sameRequest
      ? { ok: true, state, reservation: existing, replayed: true }
      : { ok: false, reason: "invalid_amount" };
  }
  if (!validMicros(input.amountMicros)) return { ok: false, reason: "invalid_amount" };
  if (input.amountMicros > config.perTurnCapMicros) return { ok: false, reason: "per_turn_cap" };
  if (totalFor(state, input.userId) + input.amountMicros > config.perUserCapMicros) {
    return { ok: false, reason: "per_user_cap" };
  }
  if (totalFor(state) + input.amountMicros > config.pilotCapMicros) {
    return { ok: false, reason: "pilot_cap" };
  }
  const reservation: SponsoredInferenceReservation = {
    id: input.id,
    userId: input.userId,
    turnId: input.turnId,
    reservedMicros: input.amountMicros,
    state: "reserved",
    billedMicros: 0,
  };
  return {
    ok: true,
    replayed: false,
    reservation,
    state: { reservations: { ...state.reservations, [input.id]: reservation } },
  };
}

export function commitSponsoredInference(
  state: SponsoredInferenceBudgetState,
  id: string,
  billedMicros: number,
): SponsoredInferenceBudgetState {
  const reservation = state.reservations[id];
  if (!reservation || reservation.state === "released") return state;
  if (
    !Number.isSafeInteger(billedMicros) ||
    billedMicros < 0 ||
    billedMicros > reservation.reservedMicros
  ) {
    return state;
  }
  if (reservation.state === "committed") return state;
  return {
    reservations: {
      ...state.reservations,
      [id]: { ...reservation, state: "committed", billedMicros },
    },
  };
}

export function releaseSponsoredInference(
  state: SponsoredInferenceBudgetState,
  id: string,
): SponsoredInferenceBudgetState {
  const reservation = state.reservations[id];
  if (!reservation || reservation.state !== "reserved") return state;
  return {
    reservations: {
      ...state.reservations,
      [id]: { ...reservation, state: "released" },
    },
  };
}

export const summarizeSponsoredInferenceBudget = (state: SponsoredInferenceBudgetState) => ({
  committedMicros: Object.values(state.reservations).reduce(
    (total, reservation) =>
      total + (reservation.state === "committed" ? reservation.billedMicros : 0),
    0,
  ),
  reservedMicros: Object.values(state.reservations).reduce(
    (total, reservation) =>
      total + (reservation.state === "reserved" ? reservation.reservedMicros : 0),
    0,
  ),
});

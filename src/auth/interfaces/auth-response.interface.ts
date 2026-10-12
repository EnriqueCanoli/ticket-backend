import type { SuscripcionSnapshot } from '../../suscripciones/interfaces/suscripcion-response.interface';

/** Shape de `user` en las respuestas de /auth/register y /auth/login (AUTH_ENDPOINTS.md sección 3). */
export interface UserResponse {
  id: string;
  email: string;
  phone: string;
  created_at: Date;
}

/** Shape de GET /me (incluye `updated_at`, a diferencia de UserResponse). */
export interface MeResponse extends UserResponse {
  updated_at: Date;
  /** Snapshot de suscripción; se omite si no se pudo calcular. */
  suscripcion?: SuscripcionSnapshot;
}

/** Par de tokens emitido por /auth/register, /auth/login y /auth/refresh. */
export interface TokenPairResponse {
  access_token: string;
  refresh_token: string;
  token_type: 'Bearer';
  expires_in: number;
}

/** Respuesta completa de /auth/register y /auth/login: usuario + tokens. */
export interface AuthResponse extends TokenPairResponse {
  user: UserResponse;
  /** Al nivel de `user` y los tokens (no dentro de `user`); se omite si el snapshot falla. */
  suscripcion?: SuscripcionSnapshot;
}

/** Shape de GET /me/pin: el PIN de desbloqueo del usuario autenticado. */
export interface PinResponse {
  pin: string;
}

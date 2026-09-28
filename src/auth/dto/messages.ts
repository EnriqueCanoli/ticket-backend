/**
 * Mensajes de validación en español de los DTOs del flujo de recuperación de
 * contraseña y de regeneración del PIN (forgot-password, reset-password y
 * me/pin/regenerate). El frontend usa las mismas reglas con textos
 * equivalentes, así que estos textos forman parte del contrato: no cambiarlos
 * sin coordinarlo con el cliente. login.dto.ts y register.dto.ts quedan fuera
 * de este flujo y mantienen sus mensajes actuales.
 */
export const PASSWORD_FORMAT_MESSAGE =
  'La contraseña debe tener al menos 6 caracteres y al menos un número';

export const PASSWORD_MAX_BYTES_MESSAGE =
  'La contraseña no puede pesar más de 72 bytes (los acentos pesan 2, los emojis hasta 4)';

export const RESET_CODE_FORMAT_MESSAGE = 'El código son 6 dígitos';

export const EMAIL_FORMAT_MESSAGE = 'Ingresa un correo válido';

/**
 * Transform reutilizable para `@Transform()` de class-transformer: recorta
 * espacios/tabs al borde y normaliza a minúsculas. Usado en los 4 DTOs de
 * auth que reciben `email` (`LoginDto`, `RegisterDto`, `ForgotPasswordDto`,
 * `ResetPasswordDto`) para que `@IsEmail()` valide sobre el valor ya
 * normalizado, en vez de rechazar con 400 un email válido con espacios/tab
 * al borde (BE-04).
 *
 * Corre aunque el `ValidationPipe` global no tenga `transform: true` (ver
 * `main.ts`): `plainToInstance` construye siempre la instancia que se valida,
 * así que `@Transform` se aplica de todas formas y `@IsEmail()` ve el valor
 * ya transformado. Verificado empíricamente instanciando el `ValidationPipe`
 * real del proyecto con estas mismas opciones.
 */
export function trimAndLowercase({ value }: { value: unknown }): unknown {
  return typeof value === 'string' ? value.trim().toLowerCase() : value;
}

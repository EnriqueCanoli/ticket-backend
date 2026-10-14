// Los e2e nunca deben usar la Google Play Developer API real, aunque el .env local tenga
// VALIDACION_TIENDA=google. Se fuerza el modo simulado antes de que se cargue la configuración.
process.env.VALIDACION_TIENDA = 'simulada';

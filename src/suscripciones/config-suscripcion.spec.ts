import { leerConfigSuscripcion } from './config-suscripcion';

describe('leerConfigSuscripcion', () => {
  it('fuera de producción y sin variables: simulada y PENDIENTE', () => {
    expect(leerConfigSuscripcion({})).toEqual({
      validacionTienda: 'simulada',
      productoSuscripcionId: 'PENDIENTE',
    });
    expect(leerConfigSuscripcion({ NODE_ENV: 'test' })).toEqual({
      validacionTienda: 'simulada',
      productoSuscripcionId: 'PENDIENTE',
    });
  });

  it('una cadena vacía cuenta como ausente', () => {
    expect(
      leerConfigSuscripcion({
        VALIDACION_TIENDA: '',
        PRODUCTO_SUSCRIPCION_ID: '',
      }),
    ).toEqual({
      validacionTienda: 'simulada',
      productoSuscripcionId: 'PENDIENTE',
    });
    expect(() =>
      leerConfigSuscripcion({
        NODE_ENV: 'production',
        VALIDACION_TIENDA: '',
        PRODUCTO_SUSCRIPCION_ID: 'suscripcion_mensual',
      }),
    ).toThrow('VALIDACION_TIENDA no configurada: requerida en producción');
  });

  it('simulada explícita fuera de producción con producto propio', () => {
    expect(
      leerConfigSuscripcion({
        NODE_ENV: 'development',
        VALIDACION_TIENDA: 'simulada',
        PRODUCTO_SUSCRIPCION_ID: 'suscripcion_mensual',
      }),
    ).toEqual({
      validacionTienda: 'simulada',
      productoSuscripcionId: 'suscripcion_mensual',
    });
  });

  it('en producción sin VALIDACION_TIENDA falla', () => {
    expect(() =>
      leerConfigSuscripcion({
        NODE_ENV: 'production',
        PRODUCTO_SUSCRIPCION_ID: 'x',
      }),
    ).toThrow('VALIDACION_TIENDA no configurada: requerida en producción');
  });

  it('simulada en producción falla', () => {
    expect(() =>
      leerConfigSuscripcion({
        NODE_ENV: 'production',
        VALIDACION_TIENDA: 'simulada',
        PRODUCTO_SUSCRIPCION_ID: 'x',
      }),
    ).toThrow(/simulada/);
  });

  it('google falla hasta la etapa 4b', () => {
    expect(() =>
      leerConfigSuscripcion({ VALIDACION_TIENDA: 'google' }),
    ).toThrow('VALIDACION_TIENDA=google se implementa en la etapa 4b');
    expect(() =>
      leerConfigSuscripcion({
        NODE_ENV: 'production',
        VALIDACION_TIENDA: 'google',
      }),
    ).toThrow('etapa 4b');
  });

  it('otro valor falla y lista los admitidos', () => {
    expect(() =>
      leerConfigSuscripcion({ VALIDACION_TIENDA: 'basura' }),
    ).toThrow('valores admitidos: simulada, google');
  });

  it('PRODUCTO_SUSCRIPCION_ID provisional o ausente en producción falla (tras validar el modo)', () => {
    // Hoy ningún modo válido llega a producción (simulada falla y google es
    // de la 4b), así que el modo se rechaza primero.
    expect(() =>
      leerConfigSuscripcion({
        NODE_ENV: 'production',
        PRODUCTO_SUSCRIPCION_ID: 'PENDIENTE',
      }),
    ).toThrow('VALIDACION_TIENDA');
  });
});

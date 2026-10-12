import {
  HMAC_SECRETO_DESARROLLO,
  leerConfigSuscripcion,
} from './config-suscripcion';

const SECRETO = 'un-secreto-de-prueba-de-al-menos-32-caracteres';
const CREDENCIALES = {
  client_email: 'servicio@proyecto.iam.gserviceaccount.com',
  private_key:
    '-----BEGIN PRIVATE KEY-----\nFALSA\n-----END PRIVATE KEY-----\n',
};
const ENV_GOOGLE = {
  VALIDACION_TIENDA: 'google',
  PRODUCTO_SUSCRIPCION_ID: 'ticket_mensual',
  PLAY_PACKAGE_NAME: 'com.canales.ticket',
  SUSCRIPCION_HMAC_SECRETO: SECRETO,
  GOOGLE_SERVICE_ACCOUNT_JSON: Buffer.from(
    JSON.stringify(CREDENCIALES),
  ).toString('base64'),
};

describe('leerConfigSuscripcion', () => {
  it('fuera de producción y sin variables: simulada y PENDIENTE', () => {
    expect(leerConfigSuscripcion({})).toMatchObject({
      validacionTienda: 'simulada',
      productoSuscripcionId: 'PENDIENTE',
    });
    expect(leerConfigSuscripcion({ NODE_ENV: 'test' })).toMatchObject({
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
    ).toMatchObject({
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
    ).toMatchObject({
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

  it('otro valor falla y lista los admitidos', () => {
    expect(() =>
      leerConfigSuscripcion({ VALIDACION_TIENDA: 'basura' }),
    ).toThrow('valores admitidos: simulada, google');
  });

  it('simulada sin secreto: usa la constante de desarrollo', () => {
    const config = leerConfigSuscripcion({});
    expect(config.hmacSecreto).toBe(HMAC_SECRETO_DESARROLLO);
    expect(config.credencialesGoogle).toBeNull();
    expect(config.paqueteAndroid).toBeNull();
  });

  it('simulada con secreto propio lo respeta', () => {
    expect(
      leerConfigSuscripcion({ SUSCRIPCION_HMAC_SECRETO: SECRETO }).hmacSecreto,
    ).toBe(SECRETO);
  });

  describe('modo google', () => {
    it('configuración completa', () => {
      expect(leerConfigSuscripcion(ENV_GOOGLE)).toEqual({
        validacionTienda: 'google',
        productoSuscripcionId: 'ticket_mensual',
        paqueteAndroid: 'com.canales.ticket',
        credencialesGoogle: CREDENCIALES,
        hmacSecreto: SECRETO,
      });
    });

    it.each([
      ['GOOGLE_SERVICE_ACCOUNT_JSON'],
      ['PLAY_PACKAGE_NAME'],
      ['SUSCRIPCION_HMAC_SECRETO'],
      ['PRODUCTO_SUSCRIPCION_ID'],
    ])('falla si falta %s', (variable) => {
      const env: Record<string, string | undefined> = { ...ENV_GOOGLE };
      delete env[variable];
      expect(() => leerConfigSuscripcion(env)).toThrow(variable);
      env[variable] = '';
      expect(() => leerConfigSuscripcion(env)).toThrow(variable);
    });

    it('falla con PRODUCTO_SUSCRIPCION_ID PENDIENTE', () => {
      expect(() =>
        leerConfigSuscripcion({
          ...ENV_GOOGLE,
          PRODUCTO_SUSCRIPCION_ID: 'PENDIENTE',
        }),
      ).toThrow('PRODUCTO_SUSCRIPCION_ID');
    });

    it('falla con un secreto corto', () => {
      expect(() =>
        leerConfigSuscripcion({
          ...ENV_GOOGLE,
          SUSCRIPCION_HMAC_SECRETO: 'corto-corto',
        }),
      ).toThrow('demasiado corta');
    });

    it('falla con base64 o JSON inválido, sin filtrar el valor', () => {
      const basura = 'esto-no-es-base64-ni-json-SECRETO-VISIBLE';
      let mensaje = '';
      try {
        leerConfigSuscripcion({
          ...ENV_GOOGLE,
          GOOGLE_SERVICE_ACCOUNT_JSON: basura,
        });
      } catch (error) {
        mensaje = (error as Error).message;
      }
      expect(mensaje).toContain('GOOGLE_SERVICE_ACCOUNT_JSON inválida');
      expect(mensaje).not.toContain('SECRETO-VISIBLE');
    });

    it('falla si el JSON no trae client_email o private_key, sin filtrar la clave', () => {
      const sinEmail = Buffer.from(
        JSON.stringify({ private_key: 'CLAVE-PRIVADA-VISIBLE' }),
      ).toString('base64');
      let mensaje = '';
      try {
        leerConfigSuscripcion({
          ...ENV_GOOGLE,
          GOOGLE_SERVICE_ACCOUNT_JSON: sinEmail,
        });
      } catch (error) {
        mensaje = (error as Error).message;
      }
      expect(mensaje).toContain('client_email');
      expect(mensaje).not.toContain('CLAVE-PRIVADA-VISIBLE');
    });
  });

  describe('producción', () => {
    it('exige el secreto HMAC de 32 caracteres o más', () => {
      const base = {
        NODE_ENV: 'production',
        ...ENV_GOOGLE,
      };
      expect(leerConfigSuscripcion(base).validacionTienda).toBe('google');
      expect(() =>
        leerConfigSuscripcion({ ...base, SUSCRIPCION_HMAC_SECRETO: '' }),
      ).toThrow('SUSCRIPCION_HMAC_SECRETO');
      expect(() =>
        leerConfigSuscripcion({ ...base, SUSCRIPCION_HMAC_SECRETO: 'abc' }),
      ).toThrow('demasiado corta');
    });

    it('producto provisional o ausente falla', () => {
      expect(() =>
        leerConfigSuscripcion({
          NODE_ENV: 'production',
          ...ENV_GOOGLE,
          PRODUCTO_SUSCRIPCION_ID: 'PENDIENTE',
        }),
      ).toThrow('PRODUCTO_SUSCRIPCION_ID');
    });
  });
});

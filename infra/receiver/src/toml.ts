// SEP-1 stellar.toml, rendered from the running configuration so the advertised endpoints always
// match the port the server actually listens on. Both currencies are marked `status = "test"`: the
// USDC is our platform test asset and the pesos are paid into a simulated encargo fiduciario.

import { RECEIVER_NAME, type ReceiverConfig } from './config.ts';

export function stellarToml(cfg: ReceiverConfig): string {
  const pk = cfg.keypair.publicKey();
  return [
    'VERSION = "2.7.0"',
    `NETWORK_PASSPHRASE = "${cfg.networkPassphrase}"`,
    `SIGNING_KEY = "${pk}"`,
    `WEB_AUTH_ENDPOINT = "${cfg.baseUrl}/auth"`,
    `KYC_SERVER = "${cfg.baseUrl}/sep12"`,
    `DIRECT_PAYMENT_SERVER = "${cfg.baseUrl}/sep31"`,
    `ANCHOR_QUOTE_SERVER = "${cfg.baseUrl}/sep38"`,
    `ACCOUNTS = ["${pk}"]`,
    '',
    '[DOCUMENTATION]',
    `ORG_NAME = "${RECEIVER_NAME}"`,
    'ORG_DESCRIPTION = "Contraparte SEP-31 de prueba: recibe USDC en testnet y simula el abono en pesos al encargo fiduciario del comprador en Fidudavivienda."',
    '',
    '[[CURRENCIES]]',
    'code = "USDC"',
    `issuer = "${cfg.usdcIssuer}"`,
    'status = "test"',
    'display_decimals = 2',
    'name = "USDC de prueba (plataforma Casa Puente)"',
    'desc = "Activo de prueba emitido por la plataforma en testnet; el ancla lo recibe y lo convierte a pesos."',
    '',
    '[[CURRENCIES]]',
    'code = "COP"',
    'status = "test"',
    'is_asset_anchored = true',
    'anchor_asset_type = "fiat"',
    'anchor_asset = "iso4217:COP"',
    'display_decimals = 0',
    'name = "Peso colombiano"',
    'desc = "Pesos abonados por ACH al encargo fiduciario del comprador en Fidudavivienda (simulado)."',
    '',
  ].join('\n');
}

import { config } from '../../config/config';
import { COMMANDS, CommandResult, emptyCommand } from './requesthandler';

export function handleSecureHello(trimmedUrl: string): CommandResult {
  const [, , , pub_key] = trimmedUrl.split('/');
  const payload = {
    command: COMMANDS.SECURE_HELLO,
    error: 0,
    public_key: pub_key,
  };
  return {
    command: trimmedUrl,
    name: COMMANDS.SECURE_HELLO,
    payload,
    raw: true,
  };
}

export function handleSecureInfoPairing(trimmedUrl: string): CommandResult {
  const payload = {
    command: COMMANDS.SECURE_INFO_PAIRING,
    error: -84,
    master: config.miniserver.mac,
    peers: [],
  };
  return {
    command: trimmedUrl,
    name: COMMANDS.SECURE_INFO_PAIRING,
    payload,
    raw: true,
  };
}

export function handleSecureAuthenticate(url: string): CommandResult {
  return emptyCommand(url, 'authentication successful');
}

export function handleSecureInit(): CommandResult {
  const jwt =
    'eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.ewogICJleHAiOiAxNjQwNjEwMTQ0LAogICJpYXQiOiAxNjQwNjEwMDg0LAogICJzZXNzaW9uX3Rva2VuIjogIjhXYWh3QWZVTHdFUWNlOVl1MHFJRTlMN1FNa1hGSGJpME05Y2g5dktjZ1lBclBQb2pYSHBTaU5jcTBmVDNscUwiLAogICJzdWIiOiAic2VjdXJlLXNlc3Npb24taW5pdC1zdWNjZXNzIgp9.Zd5M55YPirdugqlGr7u6iB-kM_oFqnvMnpxL8gj58vF2L4ocpSY6S8OB_4f8LeIB2AIYikN5U6R0UALJ3Oahxa0gq9qKDoNrjC7-Q8wAe1rEhDbvdWtaRzmgiHnivrz0cNsyeYGBX8c5Ix6pLI8URGjR1Ox2lbxBt_pVZ-MyEvhVNSJ0-DttclqIAgr_24tVmwe6lleT5eKyBoQVAcGJP-3LSdORKckHTCRw6aaf6sOQ7AtK37SXgnHB6J4g2wErvyw29mMAmDTbR8vZUCmTxgnmhbrks02AZITLaDeGAYTlSASWDSl84L9wkWOWk0pufZIGG0zcXgL8EoWD8cw_fIhbh-LXODEY5251u0DlVtaI_6J6o2j8jy_WvsSqKh-sqqy-ygScwPkLgFua7GNlppaHUGsFaEg0rVdLvVAiIV3mbOGnis1RuWcTWY9iuPVxFTODxkOZNRgZttBb_NFa8lQPJKwwhA33YC1hJ6DE3xEC2rvc4LGE400nLKnELNKpFNsom07JFSQQq8NV3Z1lzTksa8ANdXrV080J8x0c1Bt4dcUyx3lzFE8XG3DsLXCnL2YsJ9ik2jdSBZL8grnoQjqvJWaX3j47P0VM-jaMICVb6QcVP-nNB7k5n1qQGASsbkhcB1nffzE_wLooUe4iLxJQ2dkCM1n7ngXDF6HK0_A';
  const payload = {
    command: 'secure/init',
    error: 0,
    jwt,
  };
  return {
    command: 'secure/init',
    name: COMMANDS.SECURE_INIT,
    payload,
    raw: true,
  };
}

/** Synthetic HTTPS origins only: production tests never contact live services. */
export const productionEnvironment = {
  TOPMEDIAI_ENV: 'production',
  TOPMEDIAI_PRODUCTION_WEB_ORIGIN: 'https://web.production.fixture.invalid',
  TOPMEDIAI_MEMBER_HOST: 'https://member.production.fixture.invalid',
  TOPMEDIAI_IMAGE_HOST: 'https://image.production.fixture.invalid',
  TOPMEDIAI_MUSIC_HOST: 'https://music.production.fixture.invalid',
  TOPMEDIAI_TTS_HOST: 'https://tts.production.fixture.invalid',
  TOPMEDIAI_UPLOAD_HOST: 'https://upload.production.fixture.invalid',
  TOPMEDIAI_UPLOAD_PUBLIC_ORIGIN: 'https://files.topmediai.com',
};

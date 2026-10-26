/*
 * i18n — the kyour viewer components call t(key, englishDefault). With no
 * resources loaded i18next returns the English default, so the viewer reads
 * exactly as it does in kyour's English UI.
 */
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';

i18n.use(initReactI18next).init({
  lng: 'en',
  fallbackLng: 'en',
  resources: { en: { translation: {} } },
  interpolation: { escapeValue: false },
  returnNull: false,
});

export default i18n;

import { Segmented, Typography } from 'antd';
import { useTranslation } from 'react-i18next';
import { useStorage } from '@/hooks/use-storage';
import { settings } from '@/lib/storage';
import { SUPPORTED_LOCALES, type Locale } from '@/lib/i18n';

const { Text } = Typography;

/**
 * The gear-opened "Settings" view inside the side-panel home. Currently just a
 * language switch (English / Chinese); it's the home for future global settings
 * (theme, etc.). The selected locale is stored in `settings.locale`, which drives
 * both react-i18next and antd's ConfigProvider locale (see app-providers.tsx).
 */
export function SettingsFeature() {
  const { t } = useTranslation();
  const [locale, setLocale] = useStorage(settings.locale);

  const options = SUPPORTED_LOCALES.map((loc) => ({
    label: loc === 'zh-CN' ? t('settings.languageChinese') : t('settings.languageEnglish'),
    value: loc,
  }));

  return (
    <div className="flex-1 min-h-0 overflow-auto pt-4 px-3 pb-4">
      <div className="flex items-center justify-between">
        <Text strong>{t('settings.language')}</Text>
        <Segmented<Locale>
          options={options}
          value={locale}
          onChange={(v) => void setLocale(v)}
        />
      </div>
    </div>
  );
}

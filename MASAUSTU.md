# Otomatik Edit — masaüstü

## Kullanım

Windows 10/11 64-bit için `OtomatikEdit-1.1.1-win-x64.exe` dosyasını çalıştırın. Kurulum kullanıcı hesabınıza yapılır; Python, Node.js veya FFmpeg kurmanız gerekmez. Masaüstündeki **Otomatik Edit** kısayolu editörü kendi penceresinde açar.

Apple Silicon Mac için `OtomatikEdit-1.1.1-mac-arm64.dmg` içinden uygulamayı Applications klasörüne taşıyın. Intel Mac paketi bu derlemenin hedefi değildir.

Kurulum paketleri şu aşamada yayıncı sertifikasıyla imzalı/noter onaylı değildir. İşletim sistemi yayıncı doğrulama uyarısı gösterebilir. Genel dağıtım için Windows kod imzası ve Apple Developer imzalama/noter onayı ayrıca yapılandırılmalıdır.

## Eski kayıtlar ve yedekleme

1. Eski tarayıcı sürümünde çalışmanızı **Projeyi kaydet** ile adlandırarak kaydedin.
2. Masaüstünde **Dosya → Eski projeleri içe aktar…** seçin.
3. `projects` ve `uploads` klasörlerini içeren eski `SmartVideoEditor` klasörünü seçin. Bağlı medya da kopyalanır; büyük videolarda işlem sürebilir.
4. Uygulamayı yeniden açıp **Kayıtlı proje seçin** listesinden projenizi açın.

İçe aktarma orijinalleri değiştirmez. Yalnız tarayıcının kurtarma alanında bulunan, adlandırılarak kaydedilmemiş bir proje otomatik taşınmaz. Böyle bir projeyi önce eski sürümde kaydedin.

Uygulama ilk açılışta **Belgeler / Otomatik Edit** klasörünü kendisi oluşturur. Proje çubuğundaki **Proje klasörü** veya **Dosya → Proje kayıt klasörünü aç** kesin kayıt konumunu gösterir. Varsayılan konumlar:

- Windows: Kullanıcının **Belgeler\Otomatik Edit** klasörü (OneDrive yönlendirmesi varsa sistemin Belgeler konumu)
- macOS: `~/Documents/Otomatik Edit`

Bu klasörde `projects`, `uploads`, `outputs`, `recovery.json` ve önceki kurtarma kopyası bulunur. Önceki masaüstü sürümünün uygulama veri klasöründeki kayıtlar ve bağlı medya ilk açılışta buraya kopyalanır; özgün dosyalar silinmez, mevcut Belgeler kayıtlarının üzerine yazılmaz. Yedek almak için uygulama kapalıyken klasörün tamamını başka diske kopyalayın. Kurtarma elektrik kesintisi riskini azaltır; fiziksel disk arızasına karşı ayrı yedek gerekir. Uygulama güncellemesi ve Windows kaldırma işlemi proje klasörünü silmez.

Kaydedilmiş projeyi listeden seçip **Projeyi sil** kullanabilirsiniz. Onaydan sonra yalnız proje kaydı `projects/.trash` klasörüne taşınır; diğer projelerin de kullanabileceği medya dosyaları korunur. Açık çalışma silinen kayda bağlıysa kayıtsız çalışma olarak kalır; tekrar kaydetmek yeni bir proje kaydı oluşturur.

**Videoyu Dışa Aktar → Render al** tamamlanınca kaydetme konumu otomatik sorulur; ikinci kez çıktı indirme düğmesine basmak gerekmez. Konum seçimini iptal ederseniz çıktı korunur ve **Kaydetme konumu seç** ile yeniden deneyebilirsiniz. İşlem devam ederken uygulamayı kapatmak render/analizi durdurur; uygulama bunu onaylatır.

**Ekran görüntüsü al** oynatma kafasının bulunduğu anı, metinler, stickerlar, katmanlar ve efektlerle birlikte PNG olarak kaydeder. HD–4K çözünürlük seçimi proje en-boy oranını korur; editör tutamaçları ve oynatıcı düğmeleri görüntüye katılmaz.

Geniş masaüstü ekranında oynatıcı ve timeline aynı ekranda kalır; sağdaki küçük ayar/araç panelleri ve timeline kendi içinde kayar. Daha küçük pencerelerde tüm kontrollere erişim için sayfa kaydırma korunur.

## İnternet gereksinimi

Editör arayüzü, video/ses/görsel düzenleme ve FFmpeg render paketin içindedir. Konuşma tanıma ve dil çevirisi için daha büyük model ağırlıkları ilk ihtiyaçta indirilir. Modeller indirilmeden çevrimdışı altyazı/çeviri kullanılamaz. Video dosyaları bir bulut editörüne yüklenmez; işleme yerel bilgisayarda yapılır. Güncelleme kontrolü GitHub'a bağlanır.

## Geliştirici: çalıştırma ve paketleme

Geliştirme için Node.js 22+, Python 3.11 ve FFmpeg/FFprobe gerekir. Kurulumu kaynak koddan çalışan kullanıcı için aşağıdaki bağımlılıklar gereklidir; hazır kurulum kullanıcısı bunları çalıştırmaz.

```sh
python -m pip install -r requirements.txt -r requirements-build.txt
npm ci
npm start
```

Geliştirmede `SMART_EDITOR_PYTHON` ile Python yolu seçilebilir. Yoksa macOS'ta `venv/bin/python`, Windows'ta `.venv-windows/Scripts/python.exe`, ardından sistem Python'u kullanılır. Render motoru ayrı, rastgele bir `127.0.0.1` portunda başlatılır; açık tarayıcı sürümünün 4242 portuyla çakışmaz. Her açılışa özel istek anahtarı kullanılır.

Hedef işletim sisteminde tüm bağımlılıkları kurduktan sonra:

```sh
npm test
python -m unittest test_runtime_paths test_desktop_backend test_snapshot
npm run dist
```

`npm run dist`, yerel CSS'yi üretir, Python motorunu PyInstaller ile paketler ve Electron kurulumunu `dist` içine oluşturur. Python ve FFmpeg **aynı işletim sistemi/mimarisinde** paketlenmelidir; macOS'tan Windows motoru çapraz derlenmez. Windows'ta FFmpeg eksikse önce `python windows_setup.py` çalıştırılır. Gerektiğinde `SMART_EDITOR_FFMPEG` ve `SMART_EDITOR_FFPROBE` tam yolları verilebilir.

GitHub Actions'taki **Build desktop installers → Run workflow**, Windows x64 ve macOS arm64 için ayrı derleme/test yapar. Kurulumları artifact olarak saklar; otomatik yayınlamaz. Hiçbir kullanıcı videosu/projesi, geliştirme ortamı veya model önbelleği kurulum paketine alınmaz. Paket içinde üçüncü taraf lisans bilgileri bulunur.

`electron . --smoke-test` yalnız geçici bir proje klasöründe açılış, token koruması, CSS, gerçek H.264 oynatma, proje kaydı/kurtarma ve kısa MP4 render kontrolü yapar. Paketlenmiş uygulamanın çalıştırılabilir dosyasına da `--smoke-test` verilebilir; test kullanıcı kayıtlarını değiştirmez.

## Sorun giderme

**Yardım → Tanılama kayıtlarını aç** menüsündeki `desktop.log` açılış/render motoru hatalarını içerir. Kayıt proje yollarını içerebilir; paylaşmadan önce kişisel bilgileri kontrol edin. Editör açılmazsa kayıt Windows'ta `%APPDATA%\Otomatik Edit\logs`, macOS'ta `~/Library/Application Support/Otomatik Edit/logs` altındadır. Projeler ise Belgeler klasöründe tutulur.

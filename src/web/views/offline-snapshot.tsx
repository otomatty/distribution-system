/**
 * オフライン閲覧の目印と、読み込んだ時刻（要件定義書 7章「倉庫の通信」の Should）。
 * 発送リストと入荷予定一覧の結果の欄に置く。public/assets/app.js がこの目印を見て service worker（public/sw.js）を
 * 登録し、service worker は最後に読み込んだ画面を残す。通信が途切れて残した画面を返すときは、目印の値を "cached" に変える
 * （そのときだけ「通信が途切れているため…」を表示し、操作のボタンを使えなくする）。
 */
import { dateTime } from "./format";

export function OfflineSnapshot(props: {
  /** service worker の範囲（paths.shipping() など。その画面の URL） */
  scope: string;
  /** 画面を作った時刻 */
  loadedAt: Date;
}) {
  const iso = props.loadedAt.toISOString();
  return (
    <div class="offline-snapshot" data-offline-snapshot="live" data-offline-scope={props.scope}>
      <p class="snapshot-time">
        読み込んだ時刻：<time datetime={iso}>{dateTime(iso)}</time>
      </p>
      <p class="snapshot-offline" role="status">
        通信が途切れているため、この時刻に読み込んだ内容を表示しています。操作はできません。
        通信が戻ったら <a href="">読み込み直す</a>
      </p>
    </div>
  );
}

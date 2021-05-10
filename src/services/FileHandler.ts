import { 
  isPlatform,
  modalController
} from '@ionic/vue';
import router from '../router';
import parseTorrent from 'parse-torrent'
import AddTorrent from '../views/AddTorrent.vue'
import { Utils } from './Utils';
import { Emitter } from "./Emitter";
import { TransmissionRPC } from "./TransmissionRPC";
import { Capacitor,Plugins } from '@capacitor/core'; 
const { FileSelector,App } = Plugins; 

declare global {
  interface Window {
      fileOpen: any;
  }
}

let currentFile: HTMLInputElement|null;
let torrentFiles: Array<ArrayBuffer> = [];

export const FileHandler = {
  listenFileOpen(): void {
    if(isPlatform("electron") && window.fileOpen){
      window.fileOpen.receive((files: Array<ArrayBuffer>) => {
        torrentFiles = files;
        this.filesLoaded();
      });
    }
    else if(isPlatform("capacitor")){
      App.addListener('appUrlOpen', async (data) => {
        if(data.url.startsWith("magnet:")){
          this.readMagnet(data.url);
        }
        else {
          const src = Capacitor.convertFileSrc(data.url)
          this.loadFiles([src]);
        }
      })
    }
    document.body.addEventListener("dragover", (e) => e.preventDefault(), false);
    document.body.addEventListener("drop",(e) => this.handleFilesDrop(e), false);

    // Read hash from URL
    const hash = window.location.hash.substring(1)
    hash.startsWith("url:") ? this.readURL(hash.substring(4)) : this.readHashOrMagnet(hash);
  },
  async inputFile(): Promise<void> {
    if(isPlatform("capacitor") && (isPlatform("ios") || isPlatform("android"))){
      // Capacitor file chooser
      const selectedFile = await FileSelector.fileSelector({ 
        "multiple_selection": true, 
        ext: ["torrent"] 
      })

      if(isPlatform("android")){
        const paths = JSON.parse(selectedFile.paths) 
        if(paths.length>0){
          this.loadFiles(paths);
        }
      }
    }
    else {
      // Browser file chooser
      if(!currentFile){
        const input = document.createElement("input");
        input.setAttribute("type", "file");
        input.setAttribute("id", "inputFile");
        input.setAttribute("multiple", "true");
        input.setAttribute("accept", ".torrent");
        input.setAttribute("style", "display:none;");
        currentFile = document.body.appendChild(input);
        currentFile.addEventListener("change", (e) => this.handleFiles(e), false);
      }
      currentFile.click();
    }
  },
  arrayBufferToBase64( buffer: ArrayBuffer ): string {
    let binary = '';
    const bytes = new Uint8Array( buffer );
    const len = bytes.byteLength;
    for (let i = 0; i < len; i++) {
        binary += String.fromCharCode( bytes[ i ] );
    }
    return window.btoa( binary );
  },
  handleFilesDrop(e: DragEvent): void {
    e.preventDefault();
    if(e.dataTransfer){
      if(e.dataTransfer.files.length>0){
        this.readFiles(e.dataTransfer.files);
      }
      else {
        const data = e.dataTransfer.getData("text/plain");
        this.readHashOrMagnet(data);
      }
      
    }
  },
  handleFiles(e: Event): void {
    const files = (e.target as HTMLInputElement).files;
    if(files){
      this.readFiles(files)
    }
  },
  async readFiles(files: FileList): Promise<void>{
    torrentFiles = [];
    for(const file of Array.from(files)){
      torrentFiles.push(await this.readFile(file));
    }
    this.filesLoaded();
  },
  readFile(file: File): Promise<ArrayBuffer> {
    return new Promise(function (resolve, reject) {
      const reader = new FileReader();
      reader.onload = (e: any) => {
        resolve(e.target.result);
      }
      reader.onerror = () => {
        reject();
      }
      reader.readAsArrayBuffer(file);
    });
  },
  async loadFiles(paths: Array<string>): Promise<void> {
    torrentFiles = [];
    for(const path of paths){
      torrentFiles.push(await this.loadFile(path));
    }
    this.filesLoaded();
  },
  loadFile(path: string): Promise<ArrayBuffer> {
    return fetch(path)
      .then((r) => r.arrayBuffer())
  },
  filesLoaded(): void {
    const files: Array<any> = [];
    torrentFiles.forEach((torrentFile) => {
      const buffer = Buffer.from(torrentFile);
      const data = this.parseBuffer(buffer);
      const torrent = this.arrayBufferToBase64(torrentFile);
      files.push({
        data,
        torrent
      });
    });
    torrentFiles = [];
    this.newTorrentModal(files,"file");
  },
  parseBuffer(buffer: ArrayBuffer): Record<string,any>|void {
    try {
      return parseTorrent(buffer)
    } catch (error) {
      Utils.responseToast(error.message);
    }
  },
  readHashOrMagnet(text: string): void {
    let hash = text;
    if(hash.match(/^\b[0-9a-fA-F]{40}\b$/)){
      hash = `magnet:?xt=urn:btih:${hash}`;
    }
    if(hash.match(/^magnet:\?xt=urn:btih:[0-9a-zA-Z]{32,}(&.+)?$/)){
      this.readMagnet(hash);
    }
  },
  readMagnet(magnet: string): void {
    try {
      const data=parseTorrent(magnet);
      this.newTorrentModal([{data,torrent:magnet}],"magnet");
    } catch (error) {
      Utils.responseToast(error.message);
    }
  },
  readURL(url: string): void {
    if(this.isValidUrl(url)){
      parseTorrent.remote(url, (err, parsedTorrent) => {
        const data = err ? {} : parsedTorrent;
        if(data) {
          this.newTorrentModal([{data,torrent:url}],"url");
        }
      })
    }
  },
  isValidUrl(str: string): boolean {
    let url;
    try {
      url = new URL(str);
    } catch (_) {
      return false;  
    }
    return url!=null;
  },
  newTorrentModal(files: Array<any>, type: string): void {
    router.isReady().then(async () => {
      const modal = await modalController
        .create({
          component: AddTorrent,
          componentProps: {
            files,
            type
          }
        })
      modal.onDidDismiss()
        .then(() => {
          window.location.hash="";
          currentFile?.remove();
          currentFile=null;
          Emitter.emit("refresh");
        })
      return modal.present();
    });
  },
  openExplorer(dir: string, path: string, isFile=false): void{
    window.fileOpen.open(this.pathMapping(dir),path,isFile);
  },
  pathMapping(path: string): string{
    const list = TransmissionRPC.pathMapping;
    let result = path
    for(const map in list){
      if(path.startsWith(map)){
        result = list[map] + path.substr(map.length)
      }
    }
    return result;
  }
}
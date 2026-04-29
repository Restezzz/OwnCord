/// <reference types="vite/client" />

interface Window {
  webkitAudioContext?: typeof AudioContext;
}

interface RTCPeerConnection {
  __audioSender?: RTCRtpSender;
  __videoSender?: RTCRtpSender;
}

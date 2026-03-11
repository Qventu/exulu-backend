export type allFileTypes = imageTypes | fileTypes | audioTypes | videoTypes;
type audioTypes = ".mp3" | ".wav" | ".m4a" | ".mp4" | ".mpeg";
type videoTypes = ".mp4" | ".m4a" | ".mp3" | ".mpeg" | ".wav";
type imageTypes = ".png" | ".jpg" | ".jpeg" | ".gif" | ".webp";
type fileTypes =
  | ".pdf"
  | ".docx"
  | ".doc"
  | ".xlsx"
  | ".xls"
  | ".csv"
  | ".pptx"
  | ".ppt"
  | ".txt"
  | ".md"
  | ".json"
  | ".srt"
  | ".html";